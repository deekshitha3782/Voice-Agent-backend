import type { Express, Request, Response } from "express";
import type { Server } from "http";
import express from "express";
import { storage } from "./storage";
import { processVoiceMessage, generateCallSummary, type ConversationContext } from "./voiceAgent";
import { ensureCompatibleFormat, speechToText } from "./replit_integrations/audio/client";
import { availableSlots } from "../shared/schema";

const audioBodyParser = express.json({ limit: "50mb" });

const activeSessions = new Map<number, ConversationContext>();

// Beyond Presence conversation context tracking
interface BeyContext {
  callId: string;
  agentId: string;
  userId?: number;
  phoneNumber?: string;
  userName?: string;
}
const beyContexts = new Map<string, BeyContext>();

// Cache for the Beyond Presence agent (railway redeploy marker)
let beyAgentId: string | null = null;
let beyAvatarId: string | null = null;
const beyUserAgentCache = new Map<string, string>();

const BEY_API_BASE = "https://api.bey.dev/v1";

// Get a valid avatar ID from Beyond Presence
async function getValidAvatarId(apiKey: string): Promise<string | null> {
  if (beyAvatarId) return beyAvatarId;
  
  try {
    const response = await fetch(`${BEY_API_BASE}/avatars`, {
      method: "GET",
      headers: {
        "x-api-key": apiKey,
      },
    });
    
    if (!response.ok) {
      console.error("Failed to list avatars:", await response.text());
      return null;
    }
    
    const data = await response.json();
    const avatars = data?.data || [];
    
    // Find an available avatar
    const avatar = avatars.find((a: any) => a.status === "available");
    if (avatar) {
      beyAvatarId = avatar.id;
      console.log("Found Beyond Presence avatar:", beyAvatarId, avatar.name);
      return beyAvatarId;
    }
    
    console.error("No available avatars found in Beyond Presence account");
    return null;
  } catch (error) {
    console.error("Error fetching avatars:", error);
    return null;
  }
}

// Note: Beyond Presence API does not support tool calling or external_apis
// The AI collects appointment info conversationally and we process it from the transcript
// We use Just-in-Time Context to inject user appointments into per-call agents

// Create a custom agent with user appointment context for just-in-time context
async function createBeyAgentWithContext(userName: string | null, appointments: any[], phoneNumber?: string | null): Promise<string | null> {
  const apiKey = process.env.BEY_API_KEY;
  if (!apiKey) {
    console.error("BEY_API_KEY not set");
    return null;
  }
  
  const avatarId = await getValidAvatarId(apiKey);
  if (!avatarId) {
    console.error("No valid avatar found");
    return null;
  }
  
  // Format appointments for the system prompt
  let appointmentContext = "";
  const activeAppointments = appointments.filter(a => a.status !== "cancelled");
  
  if (activeAppointments.length > 0) {
    const apptList = activeAppointments
      .map((a, i) => `APPOINTMENT ${i + 1}: Date=${a.date}, Time=${a.time}, Description="${a.description || "General appointment"}"`)
      .join("\n");
    appointmentContext = `
########## REAL APPOINTMENT DATA - READ EXACTLY ##########
${apptList}
########## END OF DATA ##########

MANDATORY RULES FOR APPOINTMENTS:
1. When user asks about their appointments, you MUST read the EXACT data above
2. Say the date, time, and description EXACTLY as written - do not paraphrase or change anything
3. Count: This user has exactly ${activeAppointments.length} appointment(s)
4. DO NOT invent, guess, or make up ANY appointment information
5. If asked about appointments not in the list above, say "I don't see that appointment in your records"`;
  } else {
    appointmentContext = `
########## REAL APPOINTMENT DATA ##########
This user has ZERO appointments scheduled.
########## END OF DATA ##########

MANDATORY: Tell the user they have no appointments. Do NOT invent any.`;
  }
  
  let greeting: string;
  
  // Format phone number for display (last 4 digits masked)
  const maskedPhone = phoneNumber ? `***-***-${phoneNumber.slice(-4)}` : null;
  
  if (userName && maskedPhone) {
    greeting = `Hi there! It's lovely to connect with you. I have ${userName} here, with a phone number ending in ${phoneNumber?.slice(-4)}. Is that you? Just want to make sure I have the right person before we get started.`;
  } else if (userName) {
    greeting = `Hi ${userName}! So nice to hear from you again. I'm here to help with your appointments whenever you're ready. What can I do for you today?`;
  } else {
    greeting = "Hi there! Welcome, it's so nice to meet you. I'm here to help you with scheduling appointments. Take your time, and let me know how I can assist you today.";
  }
  
  try {
    const response = await fetch(`${BEY_API_BASE}/agents`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
      },
      body: JSON.stringify({
        name: `Session Agent - ${Date.now()}`,
        avatar_id: avatarId,
        system_prompt: `You are a warm, caring AI appointment scheduling assistant with a gentle and soothing voice.

PERSONALITY & TONE:
- Speak in a calm, warm, and reassuring manner - like a helpful friend
- Use soft, pleasant language - say things like "wonderful", "of course", "I'd be happy to help"
- Be patient and never rush the user
- Show genuine care and empathy in your responses
- Keep your responses concise but warm - don't be overly wordy

${userName ? `CURRENT USER: ${userName}` : ""}

${appointmentContext}

WHEN USER ASKS TO VIEW/CHECK THEIR APPOINTMENTS:
- Gently read out the EXACT appointments from the data above
- Say each appointment's date, time, and description exactly as written
- Example: "Let me see... You have a lovely appointment scheduled on January 30th at 9:00 AM for your doctor's visit."

WHEN USER WANTS TO BOOK A NEW APPOINTMENT:
- Warmly ask what date works best for them (weekdays 9 AM - 5 PM)
- Gently suggest available times: 9:00 AM, 10:00 AM, 11:00 AM, 2:00 PM, 3:00 PM, 4:00 PM
- Ask for a brief description of the appointment
- Confirm all details warmly and say "Wonderful, I've got that scheduled for you"

WHEN USER WANTS TO CANCEL:
- Kindly ask which appointment they'd like to cancel
- Confirm the cancellation with understanding

IMPORTANT RULES:
- Always maintain a gentle, soothing tone
- NEVER invent or guess appointment data - only use what's in the data above
- Today's date is ${new Date().toISOString().split('T')[0]}`,
        language: "en",
        greeting: greeting,
        max_session_length_minutes: 15,
        llm: {
          type: "openai"
        }
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("Failed to create per-call agent:", errorText);
      return null;
    }

    const data = await response.json();
    console.log("Created per-call Beyond Presence agent:", data.id);
    return data.id;
  } catch (error) {
    console.error("Error creating per-call agent:", error);
    return null;
  }
}

// Create or get Beyond Presence agent for appointment scheduling (fallback for unknown users)
async function getOrCreateBeyAgent(): Promise<string | null> {
  if (beyAgentId) return beyAgentId;
  
  const apiKey = process.env.BEY_API_KEY;
  if (!apiKey) {
    console.error("BEY_API_KEY not set");
    return null;
  }
  
  // First, get a valid avatar ID
  const avatarId = await getValidAvatarId(apiKey);
  if (!avatarId) {
    console.error("No valid avatar found - cannot create agent");
    return null;
  }
  
  try {
    // Try to list existing agents to find one with our name
    const listResponse = await fetch(`${BEY_API_BASE}/agents`, {
      method: "GET",
      headers: {
        "x-api-key": apiKey,
      },
    });
    
    if (listResponse.ok) {
      const agents = await listResponse.json();
      const existing = agents?.data?.find((a: any) => a.name === "Appointment Scheduler v8");
      if (existing?.id) {
        beyAgentId = existing.id;
        console.log("Found existing Beyond Presence agent:", beyAgentId);
        return beyAgentId;
      }
    }
    
    // Create a new agent (Beyond Presence doesn't support tool calling, so using conversational approach)
    console.log("Creating new Beyond Presence agent with avatar:", avatarId);
    const response = await fetch(`${BEY_API_BASE}/agents`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
      },
      body: JSON.stringify({
        name: "Appointment Scheduler v9",
        avatar_id: avatarId,
        system_prompt: `You are a warm, caring AI appointment scheduling assistant with a gentle and soothing voice. Your job is to help users book and manage appointments through natural, friendly conversation.

PERSONALITY & TONE:
- Speak in a calm, warm, and reassuring manner - like a helpful friend
- Use soft, pleasant language - say things like "wonderful", "of course", "I'd be happy to help"
- Be patient and never rush the user
- Show genuine care and empathy in your responses
- Keep your responses concise but warm - don't be overly wordy

CRITICAL RULES:
- NEVER invent, make up, or guess appointment information
- NEVER pretend to look up appointments in a database
- You cannot access appointment data directly - when users ask to view appointments, gently direct them to check the side panel

WORKFLOW:
1. Greet the user warmly and make them feel welcome
2. Kindly ask for their name and 10-digit phone number to identify them
3. Once they provide their info, warmly confirm and ask what they'd like help with:
   - Book a new appointment
   - Check their existing appointments  
   - Cancel an appointment
4. For BOOKING:
   - Gently ask what date works best for them (available weekdays between 9 AM and 5 PM)
   - Suggest time slots: 9:00 AM, 10:00 AM, 11:00 AM, 2:00 PM, 3:00 PM, 4:00 PM
   - Ask for a brief description of what the appointment is for
   - Confirm all details warmly: date, time, and description
   - Say "Wonderful, I've got that scheduled for you"
5. For VIEWING appointments:
   - Kindly tell them: "Your appointments should appear in the side panel on your screen. Please take a look there."
   - Ask if they can see them and if there's anything else you can help with
6. For CANCELLATION:
   - Kindly ask which appointment they'd like to cancel (date and time)
   - Confirm with understanding: "Of course, I've noted your request to cancel"

IMPORTANT:
- Always maintain a gentle, soothing tone
- Keep responses concise and natural
- All appointment bookings and cancellations are recorded for confirmation
- Today's date is ${new Date().toISOString().split('T')[0]}`,
        language: "en",
        greeting: "Hi there! Welcome, it's so nice to meet you. I'm here to help you with scheduling appointments. To get started, could you please share your name and phone number with me?",
        max_session_length_minutes: 15,
        llm: {
          type: "openai"
        }
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error("Failed to create Beyond Presence agent:", errorText);
      return null;
    }

    const data = await response.json();
    beyAgentId = data.id;
    console.log("Created Beyond Presence agent:", beyAgentId);
    return beyAgentId;
  } catch (error) {
    console.error("Error creating/finding Beyond Presence agent:", error);
    return null;
  }
}

export async function registerRoutes(httpServer: Server, app: Express): Promise<Server> {
  
  // Session management endpoints
  app.post("/api/sessions", async (req: Request, res: Response) => {
    try {
      const { phoneNumber } = req.body || {};
      let userId = null;
      
      // If phone number provided, look up the user
      if (phoneNumber) {
        const digitsOnly = phoneNumber.replace(/\D/g, "");
        if (digitsOnly.length >= 10) {
          const user = await storage.getUserByPhoneNumber(digitsOnly);
          if (user) {
            userId = user.id;
            console.log(`Session created for user ${user.name} (${user.id})`);
          }
        }
      }
      
      const session = await storage.createCallSession({ 
        status: "active",
        userId: userId,
        phoneNumber: phoneNumber?.replace(/\D/g, "") || null,
      });
      activeSessions.set(session.id, {
        sessionId: session.id,
        messages: [],
      });
      res.status(201).json(session);
    } catch (error) {
      console.error("Error creating session:", error);
      if (error instanceof Error) {
        console.error("Error details:", error.message, error.stack);
      }
      res.status(500).json({ error: "Failed to create session", details: error instanceof Error ? error.message : "Unknown error" });
    }
  });

  app.post("/api/sessions/:id/end", async (req: Request, res: Response) => {
    try {
      const sessionId = parseInt(req.params.id as string);
      const { transcript } = req.body || {};
      
      // Generate summary using AI, passing transcript if provided
      const summaryData = await generateCallSummary(sessionId, transcript);
      
      activeSessions.delete(sessionId);
      res.json(summaryData);
    } catch (error) {
      console.error("Error ending session:", error);
      res.status(500).json({ error: "Failed to end session" });
    }
  });

  // Voice message processing endpoint for local voice agent
  app.post("/api/voice", audioBodyParser, async (req: Request, res: Response) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();

    try {
      const { audio, sessionId, mimeType } = req.body;
      
      if (!audio) {
        res.write(`data: ${JSON.stringify({ error: "No audio data provided" })}\n\n`);
        res.end();
        return;
      }

      // Get or create session context
      let context = activeSessions.get(sessionId);
      if (!context) {
        context = {
          sessionId,
          messages: [],
        };
        activeSessions.set(sessionId, context);
      }

      // Convert audio data
      const audioBuffer = Buffer.from(audio, "base64");
      const compatibleAudio = await ensureCompatibleFormat(audioBuffer);

      // Transcribe audio
      const transcript = await speechToText(compatibleAudio.buffer, compatibleAudio.format);
      
      if (!transcript || transcript.trim() === "") {
        res.write(`data: ${JSON.stringify({ error: "Could not transcribe audio" })}\n\n`);
        res.end();
        return;
      }

      // Send transcript event
      res.write(`data: ${JSON.stringify({ type: "transcript", text: transcript })}\n\n`);

      // Process the message through the voice agent
      const responseIterator = processVoiceMessage(transcript, context);
      
      for await (const chunk of responseIterator) {
        res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      }

      // Update session with new context
      activeSessions.set(sessionId, context);

      res.write(`data: ${JSON.stringify({ type: "done" })}\n\n`);
      res.end();
    } catch (error) {
      console.error("Error processing voice:", error);
      res.write(`data: ${JSON.stringify({ error: "Failed to process voice message" })}\n\n`);
      res.end();
    }
  });

  // Voice transcription endpoint for animated avatar
  const multer = await import("multer");
  const upload = multer.default({ storage: multer.memoryStorage() });
  
  app.post("/api/voice/transcribe", upload.single("audio"), async (req: Request, res: Response) => {
    try {
      const file = (req as any).file;
      
      if (!file || !file.buffer || file.buffer.length < 100) {
        return res.status(400).json({ error: "No audio data provided" });
      }

      const compatibleAudio = await ensureCompatibleFormat(file.buffer);
      const transcript = await speechToText(compatibleAudio.buffer, compatibleAudio.format);
      
      res.json({ text: transcript || "" });
    } catch (error) {
      console.error("Transcription error:", error);
      res.status(500).json({ error: "Failed to transcribe audio" });
    }
  });

  // Voice chat endpoint for animated avatar
  app.post("/api/voice/chat", async (req: Request, res: Response) => {
    try {
      const { message, sessionId = 0 } = req.body;
      
      if (!message) {
        return res.status(400).json({ error: "No message provided" });
      }

      // Get or create session context
      let context = activeSessions.get(sessionId);
      if (!context) {
        context = {
          sessionId,
          messages: [],
        };
        activeSessions.set(sessionId, context);
      }

      // Process through voice agent and collect full response
      const responseIterator = processVoiceMessage(message, context);
      let fullResponse = "";
      
      for await (const chunk of responseIterator) {
        if (chunk.type === "transcript" && chunk.data) {
          fullResponse += chunk.data;
        }
      }

      activeSessions.set(sessionId, context);
      
      res.json({ response: fullResponse });
    } catch (error) {
      console.error("Chat error:", error);
      res.status(500).json({ error: "Failed to process chat" });
    }
  });

  // Text-to-speech endpoint for animated avatar using gpt-audio-mini
  app.post("/api/voice/speak", async (req: Request, res: Response) => {
    try {
      const { text } = req.body;
      
      if (!text) {
        return res.status(400).json({ error: "No text provided" });
      }

      // Use OpenAI chat with audio output (gpt-audio-mini supports audio modality)
      const openai = await import("openai");
      const client = new openai.default({
        apiKey: process.env.AI_INTEGRATIONS_OPENAI_API_KEY,
        baseURL: process.env.AI_INTEGRATIONS_OPENAI_BASE_URL,
      });

      const response = await client.chat.completions.create({
        model: "gpt-audio-mini",
        modalities: ["text", "audio"],
        audio: { voice: "alloy", format: "wav" },
        messages: [
          {
            role: "system",
            content: "You are a text-to-speech converter. Repeat the user's text exactly as provided, without any changes or additions."
          },
          {
            role: "user",
            content: `Please read this text aloud: "${text}"`
          }
        ],
      });

      // Extract audio data from response
      const audioData = (response.choices[0]?.message as any)?.audio?.data;
      
      if (!audioData) {
        console.error("No audio data in response:", JSON.stringify(response.choices[0]?.message));
        return res.status(500).json({ error: "No audio generated" });
      }

      // Audio data is base64 encoded WAV
      const audioBuffer = Buffer.from(audioData, "base64");
      
      res.setHeader("Content-Type", "audio/wav");
      res.send(audioBuffer);
    } catch (error) {
      console.error("TTS error:", error);
      res.status(500).json({ error: "Failed to generate speech" });
    }
  });

  // Get available appointment slots
  app.get("/api/slots", async (req: Request, res: Response) => {
    try {
      const bookedSlots = await storage.getBookedSlots();
      const bookedSet = new Set(bookedSlots.map(s => `${s.date}-${s.time}`));
      
      const available = availableSlots.filter(slot => 
        !bookedSet.has(`${slot.date}-${slot.time}`)
      );
      
      res.json(available);
    } catch (error) {
      console.error("Error fetching slots:", error);
      res.status(500).json({ error: "Failed to fetch slots" });
    }
  });

  // Get appointments for current user
  app.get("/api/appointments", async (req: Request, res: Response) => {
    try {
      const userId = parseInt(req.query.userId as string);
      if (!userId) {
        return res.json([]);
      }
      
      const appointments = await storage.getAppointmentsByUser(userId);
      res.json(appointments);
    } catch (error) {
      console.error("Error fetching appointments:", error);
      res.status(500).json({ error: "Failed to fetch appointments" });
    }
  });

  // ===== BEYOND PRESENCE API ENDPOINTS =====
  
  // Create a Beyond Presence video call
  app.post("/api/bey/call", async (req: Request, res: Response) => {
    try {
      const apiKey = process.env.BEY_API_KEY;
      if (!apiKey) {
        return res.status(500).json({ error: "Beyond Presence API key not configured" });
      }

      const { phoneNumber } = req.body;
      console.log("Creating call with phoneNumber:", phoneNumber);
      let agentId: string | null = null;
      let userName: string | null = null;
      let appointments: any[] = [];
      
      // If phone number provided, look up user and create custom agent with their appointments
      if (phoneNumber) {
        console.log("Phone number provided, looking up user...");
        const digitsOnly = phoneNumber.replace(/\D/g, "");
        if (digitsOnly.length >= 10) {
          const user = await storage.getUserByPhoneNumber(digitsOnly);
          if (user) {
            userName = user.name;
            appointments = await storage.getAppointmentsByUser(user.id);
            console.log(`Found user ${userName} with ${appointments.length} appointments:`, 
              appointments.map(a => `${a.date} ${a.time} - ${a.description}`));

            // Reuse cached per-user agent to reduce connection latency
            const cachedAgentId = beyUserAgentCache.get(digitsOnly);
            if (cachedAgentId) {
              console.log("Using cached Beyond Presence agent for user:", cachedAgentId);
              agentId = cachedAgentId;
            } else if (appointments.length > 0) {
              // Create a custom agent with this user's appointment context only when needed
              console.log("Creating new custom agent with user's appointments...");
              agentId = await createBeyAgentWithContext(userName, appointments, digitsOnly);
              if (agentId) {
                beyUserAgentCache.set(digitsOnly, agentId);
              }
              console.log("Custom agent created:", agentId);
            } else {
              console.log("No existing appointments - skip custom agent for faster connection");
            }
          } else {
            console.log("No user found for phone:", digitsOnly);
          }
        }
      }
      
      // Fallback to default agent if no custom agent was created
      if (!agentId) {
        console.log("No custom agent - falling back to default agent");
        agentId = await getOrCreateBeyAgent();
      }
      
      if (!agentId) {
        console.error("Could not create/find Beyond Presence agent");
        return res.status(500).json({ 
          error: "Failed to initialize AI agent", 
          details: "Could not create agent. Please check BEY_API_KEY configuration." 
        });
      }

      console.log("Creating Beyond Presence call with agent:", agentId, "for user:", userName || "unknown");

      const response = await fetch(`${BEY_API_BASE}/calls`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
        },
        body: JSON.stringify({
          agent_id: agentId,
          livekit_username: "User",
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error("Beyond Presence API error:", errorText);
        return res.status(response.status).json({ error: "Failed to create call", details: errorText });
      }

      const data = await response.json();
      console.log("Beyond Presence call created:", data.id);
      
      // Store the call context
      if (data.id) {
        beyContexts.set(data.id, {
          callId: data.id,
          agentId: agentId,
        });
      }
      
      res.json({
        call_id: data.id,
        livekit_url: data.livekit_url,
        livekit_token: data.livekit_token,
        agent_id: data.agent_id,
        started_at: data.started_at,
      });
    } catch (error) {
      console.error("Error creating Beyond Presence call:", error);
      res.status(500).json({ error: "Failed to create call" });
    }
  });

  // End a Beyond Presence call (cleanup)
  app.post("/api/bey/call/:id/end", async (req: Request, res: Response) => {
    try {
      const callId = req.params.id as string;
      
      // Clean up context
      beyContexts.delete(callId);
      
      // Note: Beyond Presence calls auto-end when participants leave
      res.json({ success: true });
    } catch (error) {
      console.error("Error ending Beyond Presence call:", error);
      res.status(500).json({ error: "Failed to end call" });
    }
  });

  // Get available Beyond Presence avatars
  app.get("/api/bey/avatars", async (req: Request, res: Response) => {
    try {
      const apiKey = process.env.BEY_API_KEY;
      if (!apiKey) {
        return res.status(500).json({ error: "Beyond Presence API key not configured" });
      }

      const response = await fetch(`${BEY_API_BASE}/avatars`, {
        method: "GET",
        headers: {
          "x-api-key": apiKey,
        },
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error("Beyond Presence avatars error:", errorText);
        return res.status(response.status).json({ error: "Failed to fetch avatars" });
      }

      const data = await response.json();
      res.json(data);
    } catch (error) {
      console.error("Error fetching Beyond Presence avatars:", error);
      res.status(500).json({ error: "Failed to fetch avatars" });
    }
  });

  // Tool execution endpoint - called by client when user provides info
  app.post("/api/bey/tool-execute", async (req: Request, res: Response) => {
    try {
      const { tool_name, arguments: args, call_id } = req.body;
      console.log("Tool execution request:", tool_name, args, call_id);
      
      if (!tool_name) {
        return res.status(400).json({ error: "No tool name provided" });
      }
      
      let result = "";
      let context: BeyContext = beyContexts.get(call_id) || { callId: call_id, agentId: "" };
      
      switch (tool_name) {
        case "identify_user": {
          const phone = (args?.phone_number as string) || "";
          const name = (args?.name as string) || "";
          const digitsOnly = phone.replace(/\D/g, "");
          
          if (!digitsOnly) {
            result = "Please provide a valid phone number.";
            break;
          }
          
          let user = await storage.getUserByPhoneNumber(digitsOnly);
          const isNew = !user;
          
          if (!user) {
            user = await storage.createUser({ phoneNumber: digitsOnly, name: name || undefined });
          } else if (name && !user.name) {
            await storage.updateUser(user.id, { name });
            user = { ...user, name };
          }
          
          context.userId = user.id;
          context.phoneNumber = digitsOnly;
          context.userName = user.name || undefined;
          beyContexts.set(call_id, context);
          
          if (isNew) {
            if (!name) {
              result = `I've confirmed your phone number ending in ${digitsOnly.slice(-4)}. May I have your name please?`;
            } else {
              result = `Thank you, ${name}! I've created your account. You don't have any appointments scheduled yet. Would you like to book an appointment?`;
            }
          } else {
            const userName = user.name ? `, ${user.name}` : "";
            const appointments = await storage.getAppointmentsByUser(user.id);
            const active = appointments.filter(a => a.status !== "cancelled");
            
            if (active.length === 0) {
              result = `Welcome back${userName}! Your phone number ending in ${digitsOnly.slice(-4)} is confirmed. You don't have any appointments scheduled. Would you like to book one?`;
            } else {
              const list = active.map(a => 
                `${a.date} at ${a.time}${a.description ? ` for ${a.description}` : ""}`
              ).join("; ");
              result = `Welcome back${userName}! I found ${active.length} appointment${active.length > 1 ? 's' : ''} for you: ${list}. Would you like to book a new appointment, or modify or cancel an existing one?`;
            }
          }
          break;
        }
        
        case "set_user_name": {
          if (!context.userId) {
            result = "Please provide your phone number first.";
            break;
          }
          
          const name = (args?.name as string) || "";
          if (!name) {
            result = "Please tell me your name.";
            break;
          }
          
          await storage.updateUser(context.userId, { name });
          context.userName = name;
          beyContexts.set(call_id, context);
          
          result = `Thank you, ${name}! Your name has been saved. Would you like to book an appointment?`;
          break;
        }
        
        case "fetch_slots": {
          const dateFilter = args?.date as string | undefined;
          const bookedSlots = await storage.getBookedSlots();
          const bookedSet = new Set(bookedSlots.map(s => `${s.date}-${s.time}`));
          
          let available = availableSlots.filter(slot => !bookedSet.has(`${slot.date}-${slot.time}`));
          
          if (dateFilter) {
            available = available.filter(slot => slot.date === dateFilter);
          }
          
          available = available.slice(0, 6);
          
          if (available.length === 0) {
            result = dateFilter 
              ? `No available slots on ${dateFilter}. Would you like to check another date?`
              : "No available slots at the moment. Please try again later.";
          } else {
            const slotList = available.map(s => `${s.date} at ${s.time}`).join("; ");
            result = `Available slots: ${slotList}. Which time works best for you?`;
          }
          break;
        }
        
        case "book_appointment": {
          if (!context.userId) {
            result = "Please provide your phone number first so I can identify you.";
            break;
          }
          
          const date = args?.date as string;
          const time = args?.time as string;
          const description = args?.description as string || "General appointment";
          
          if (!date || !time) {
            result = "Please specify a date and time for your appointment.";
            break;
          }
          
          const bookedSlots = await storage.getBookedSlots();
          const isBooked = bookedSlots.some(s => s.date === date && s.time === time);
          
          if (isBooked) {
            result = `Sorry, the slot on ${date} at ${time} is already booked. Would you like to check other available times?`;
            break;
          }
          
          const appointment = await storage.createAppointment({
            userId: context.userId,
            date,
            time,
            description,
            status: "confirmed",
          });
          
          result = `Great! I've booked your appointment for ${date} at ${time}${description !== "General appointment" ? ` for ${description}` : ""}. Your confirmation number is ${appointment.id}. Is there anything else I can help you with?`;
          break;
        }
        
        case "retrieve_appointments": {
          if (!context.userId) {
            result = "Please provide your phone number first so I can look up your appointments.";
            break;
          }
          
          const appointments = await storage.getAppointmentsByUser(context.userId);
          const active = appointments.filter(a => a.status !== "cancelled");
          
          if (active.length === 0) {
            result = "You don't have any active appointments. Would you like to book one?";
          } else {
            const list = active.map(a => 
              `ID ${a.id}: ${a.date} at ${a.time}${a.description ? ` for ${a.description}` : ""} (${a.status})`
            ).join("; ");
            result = `Your appointments: ${list}. Would you like to modify or cancel any of these?`;
          }
          break;
        }
        
        case "cancel_appointment": {
          if (!context.userId) {
            result = "Please provide your phone number first.";
            break;
          }
          
          const appointmentId = args?.appointment_id as number;
          
          if (!appointmentId) {
            result = "Please specify which appointment you'd like to cancel.";
            break;
          }
          
          const appointment = await storage.getAppointment(appointmentId);
          
          if (!appointment) {
            result = `I couldn't find appointment ${appointmentId}.`;
            break;
          }
          
          if (appointment.userId !== context.userId) {
            result = "You can only cancel your own appointments.";
            break;
          }
          
          if (appointment.status === "cancelled") {
            result = "This appointment is already cancelled.";
            break;
          }
          
          await storage.cancelAppointment(appointmentId);
          result = `Done! I've cancelled your appointment on ${appointment.date} at ${appointment.time}.`;
          break;
        }
        
        default:
          result = `I don't recognize that action. I can help you book, view, modify, or cancel appointments.`;
      }
      
      console.log("Tool execution result:", result.substring(0, 100));
      res.json({ result, success: true });
    } catch (error) {
      console.error("Error executing tool:", error);
      res.status(500).json({ error: "Tool execution failed" });
    }
  });

  // ===== BEYOND PRESENCE WEBHOOK ENDPOINT =====
  
  // Webhook to receive Beyond Presence events (messages, call ended, etc.)
  app.post("/api/bey/webhook", async (req: Request, res: Response) => {
    try {
      const body = req.body;
      console.log("Beyond Presence webhook received:", JSON.stringify(body).substring(0, 500));
      
      const { call_id, message, call_data, event_type, tool_call, tool_name, parameters, session_id } = body;
      
      // Determine if this is a tool call - handle both payload formats
      // Format 1: { event_type: "tool_call", tool_call: { name, parameters, id } }
      // Format 2: { tool_name, parameters, call_id/session_id }
      const isToolCall = (event_type === "tool_call" && tool_call) || tool_name;
      
      if (isToolCall) {
        // Extract tool details from either format
        const toolName = tool_call?.name || tool_name;
        const args = tool_call?.parameters || parameters || {};
        const toolCallId = tool_call?.id || body.id || `tool-${Date.now()}`;
        const callContext = call_id || session_id || "unknown";
        
        console.log(`Tool call received: ${toolName}`, JSON.stringify(args), "call:", callContext);
        
        let context: BeyContext = beyContexts.get(callContext) || { callId: callContext, agentId: "" };
        let result: string = "";
        
        switch (toolName) {
          case "identify_user": {
            const phone = (args?.phone_number as string) || "";
            const name = (args?.name as string) || "";
            const digitsOnly = phone.replace(/\D/g, "");
            
            if (!digitsOnly || digitsOnly.length < 10) {
              result = "Please provide a valid 10-digit phone number.";
              break;
            }
            
            let user = await storage.getUserByPhoneNumber(digitsOnly);
            const isNew = !user;
            
            if (!user) {
              user = await storage.createUser({ phoneNumber: digitsOnly, name: name || undefined });
            } else if (name && !user.name) {
              await storage.updateUser(user.id, { name });
              user = { ...user, name };
            }
            
            context.userId = user.id;
            context.phoneNumber = digitsOnly;
            context.userName = user.name || undefined;
            beyContexts.set(callContext, context);
            
            const appointments = await storage.getAppointmentsByUser(user.id);
            const activeAppts = appointments.filter(a => a.status !== "cancelled");
            
            if (isNew) {
              result = `Welcome! I've created a new account for ${user.name || "you"} with phone number ending in ${digitsOnly.slice(-4)}. You don't have any appointments scheduled yet. Would you like to book one?`;
            } else {
              if (activeAppts.length > 0) {
                const apptList = activeAppts.map(a => `- ID ${a.id}: ${a.date} at ${a.time}${a.description ? ` (${a.description})` : ""} - ${a.status}`).join("\n");
                result = `Welcome back, ${user.name || "valued customer"}! I found your account. Here are your current appointments:\n${apptList}\n\nWould you like to book a new appointment, cancel one, or do something else?`;
              } else {
                result = `Welcome back, ${user.name || "valued customer"}! I found your account but you don't have any active appointments. Would you like to book one?`;
              }
            }
            break;
          }
          
          case "get_user_appointments": {
            if (!context.userId) {
              result = "Please identify the user first by providing their phone number.";
              break;
            }
            
            const appointments = await storage.getAppointmentsByUser(context.userId);
            const activeAppts = appointments.filter(a => a.status !== "cancelled");
            
            if (activeAppts.length === 0) {
              result = "You don't have any active appointments. Would you like to book one?";
            } else {
              const apptList = activeAppts.map(a => `- ID ${a.id}: ${a.date} at ${a.time}${a.description ? ` (${a.description})` : ""} - ${a.status}`).join("\n");
              result = `Here are your current appointments:\n${apptList}`;
            }
            break;
          }
          
          case "get_available_slots": {
            const date = args?.date as string;
            if (!date) {
              result = "Please specify a date to check availability.";
              break;
            }
            
            // Check which slots are already booked
            const bookedSlots = await storage.getBookedSlots();
            const slotsForDate = bookedSlots
              .filter(s => s.date === date)
              .map(s => s.time);
            
            const allSlots = ["9:00 AM", "10:00 AM", "11:00 AM", "2:00 PM", "3:00 PM", "4:00 PM"];
            const availableSlots = allSlots.filter(s => !slotsForDate.includes(s));
            
            if (availableSlots.length === 0) {
              result = `Sorry, all slots are booked for ${date}. Would you like to try a different date? Available dates are January 28-31 and February 1, 2026.`;
            } else {
              result = `Available slots for ${date}: ${availableSlots.join(", ")}. Which time works best for you?`;
            }
            break;
          }
          
          case "book_appointment": {
            if (!context.userId) {
              result = "Please identify the user first before booking an appointment.";
              break;
            }
            
            const date = args?.date as string;
            const time = args?.time as string;
            const description = (args?.description as string) || "General appointment";
            
            if (!date || !time) {
              result = "Please provide both a date and time for the appointment.";
              break;
            }
            
            // Check if slot is available
            const bookedSlotsForBooking = await storage.getBookedSlots();
            const isBooked = bookedSlotsForBooking.some(s => 
              s.date === date && s.time === time
            );
            
            if (isBooked) {
              result = `Sorry, the ${time} slot on ${date} is already booked. Would you like to try a different time?`;
              break;
            }
            
            const appointment = await storage.createAppointment({
              userId: context.userId,
              date,
              time,
              description,
              status: "scheduled"
            });
            
            result = `Great! I've booked your appointment for ${date} at ${time}. Your confirmation number is ${appointment.id}. Is there anything else I can help you with?`;
            break;
          }
          
          case "cancel_appointment": {
            const apptId = args?.appointment_id as number;
            if (!apptId) {
              result = "Please specify which appointment to cancel by its ID number.";
              break;
            }
            
            const appointment = await storage.getAppointment(apptId);
            if (!appointment) {
              result = `I couldn't find an appointment with ID ${apptId}. Would you like me to show your appointments?`;
              break;
            }
            
            if (context.userId && appointment.userId !== context.userId) {
              result = "That appointment doesn't belong to your account.";
              break;
            }
            
            await storage.updateAppointment(apptId, { status: "cancelled" });
            result = `I've cancelled your appointment for ${appointment.date} at ${appointment.time}. Is there anything else I can help you with?`;
            break;
          }
          
          default:
            result = `Unknown tool: ${toolName}`;
        }
        
        console.log(`Tool result for ${toolName}:`, result.substring(0, 100));
        
        // Return tool result to Beyond Presence
        return res.json({
          tool_call_id: toolCallId,
          result: result
        });
      }
      
      // Handle regular messages
      if (message) {
        const { sender, message: text } = message;
        console.log(`[${sender}]: ${text?.substring(0, 100)}`);
        
        // Track conversation for context
        const context = beyContexts.get(call_id);
        if (context) {
          // Auto-detect phone numbers in user messages
          if (sender === "user" && text) {
            const phoneMatch = text.match(/(\d{3}[-.\s]?\d{3}[-.\s]?\d{4}|\d{10,11})/);
            if (phoneMatch) {
              const digitsOnly = phoneMatch[0].replace(/\D/g, "");
              const user = await storage.getUserByPhoneNumber(digitsOnly);
              if (user) {
                context.userId = user.id;
                context.phoneNumber = digitsOnly;
                context.userName = user.name || undefined;
                beyContexts.set(call_id, context);
                console.log("Auto-identified user from webhook:", user.id, user.name);
              }
            }
          }
        }
      }
      
      res.json({ status: "ok" });
    } catch (error) {
      console.error("Webhook error:", error);
      res.json({ status: "error" });
    }
  });
  
  // User lookup endpoint for frontend
  app.post("/api/users/lookup", async (req: Request, res: Response) => {
    try {
      const { phoneNumber, name, callId } = req.body;
      const digitsOnly = (phoneNumber || "").replace(/\D/g, "");
      
      if (!digitsOnly || digitsOnly.length < 10) {
        return res.status(400).json({ error: "Invalid phone number" });
      }
      
      let user = await storage.getUserByPhoneNumber(digitsOnly);
      const isNew = !user;
      
      if (!user) {
        user = await storage.createUser({ phoneNumber: digitsOnly, name: name || undefined });
      } else if (name && !user.name) {
        await storage.updateUser(user.id, { name });
        user = { ...user, name };
      }
      
      // Update Beyond Presence context if call_id provided
      if (callId) {
        const context: BeyContext = beyContexts.get(callId) || { callId, agentId: "" };
        context.userId = user.id;
        context.phoneNumber = digitsOnly;
        context.userName = user.name || undefined;
        beyContexts.set(callId, context);
      }
      
      // Get user's appointments
      const appointments = await storage.getAppointmentsByUser(user.id);
      const activeAppointments = appointments.filter(a => a.status !== "cancelled");
      
      res.json({
        user,
        isNew,
        appointments: activeAppointments
      });
    } catch (error) {
      console.error("User lookup error:", error);
      res.status(500).json({ error: "Failed to lookup user" });
    }
  });
  
  // Get appointments for a user by phone number
  app.get("/api/users/:phoneNumber/appointments", async (req: Request, res: Response) => {
    try {
      const phoneParam = req.params.phoneNumber as string;
      const digitsOnly = (phoneParam || "").replace(/\D/g, "");
      
      if (!digitsOnly) {
        return res.json([]);
      }
      
      const user = await storage.getUserByPhoneNumber(digitsOnly);
      if (!user) {
        return res.json([]);
      }
      
      const appointments = await storage.getAppointmentsByUser(user.id);
      res.json(appointments.filter(a => a.status !== "cancelled"));
    } catch (error) {
      console.error("Error fetching user appointments:", error);
      res.status(500).json({ error: "Failed to fetch appointments" });
    }
  });

  // ===== LEGACY TAVUS ENDPOINTS (keeping for backward compatibility) =====
  
  // Tavus webhook handler - kept for any existing webhooks
  app.post("/api/tavus/webhook", async (req: Request, res: Response) => {
    console.log("Tavus webhook received (legacy):", req.body?.event_type);
    res.json({ status: "ok" });
  });

  return httpServer;
}
