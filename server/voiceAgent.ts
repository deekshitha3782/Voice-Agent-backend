import OpenAI from "openai";
import { storage } from "./storage";
import { availableSlots } from "../shared/schema";

// Use Groq for free LLM inference (compatible with OpenAI SDK)
const openai = new OpenAI({
  apiKey: process.env.GROQ_API_KEY || process.env.OPENAI_API_KEY,
  baseURL: process.env.GROQ_API_KEY ? "https://api.groq.com/openai/v1" : undefined,
});

export interface ToolCallEvent {
  type: "tool_call_start" | "tool_call_end";
  id: string;
  name: string;
  parameters?: Record<string, unknown>;
  result?: string;
}

export interface ConversationContext {
  sessionId: number;
  userId?: number;
  phoneNumber?: string;
  userName?: string;
  messages: { role: "user" | "assistant" | "system"; content: string }[];
}

const toolDefinitions = [
  {
    type: "function" as const,
    function: {
      name: "identify_user",
      description: "Identify a user by their phone number. Use this when the user provides their phone number.",
      parameters: {
        type: "object",
        properties: {
          phone_number: {
            type: "string",
            description: "The user's phone number"
          }
        },
        required: ["phone_number"]
      }
    }
  },
  {
    type: "function" as const,
    function: {
      name: "fetch_slots",
      description: "Fetch available appointment slots. Use this when the user asks about available times.",
      parameters: {
        type: "object",
        properties: {
          date: {
            type: "string",
            description: "Optional specific date to filter slots (YYYY-MM-DD format)"
          }
        }
      }
    }
  },
  {
    type: "function" as const,
    function: {
      name: "book_appointment",
      description: "Book an appointment for the user. Requires user to be identified first.",
      parameters: {
        type: "object",
        properties: {
          date: {
            type: "string",
            description: "The date for the appointment (YYYY-MM-DD format)"
          },
          time: {
            type: "string",
            description: "The time for the appointment (e.g., '09:00 AM')"
          },
          description: {
            type: "string",
            description: "Optional description for the appointment"
          }
        },
        required: ["date", "time"]
      }
    }
  },
  {
    type: "function" as const,
    function: {
      name: "retrieve_appointments",
      description: "Retrieve all appointments for the current user.",
      parameters: {
        type: "object",
        properties: {}
      }
    }
  },
  {
    type: "function" as const,
    function: {
      name: "cancel_appointment",
      description: "Cancel an existing appointment by its ID.",
      parameters: {
        type: "object",
        properties: {
          appointment_id: {
            type: "number",
            description: "The ID of the appointment to cancel"
          }
        },
        required: ["appointment_id"]
      }
    }
  },
  {
    type: "function" as const,
    function: {
      name: "modify_appointment",
      description: "Modify an existing appointment's date or time.",
      parameters: {
        type: "object",
        properties: {
          appointment_id: {
            type: "number",
            description: "The ID of the appointment to modify"
          },
          new_date: {
            type: "string",
            description: "The new date (YYYY-MM-DD format)"
          },
          new_time: {
            type: "string",
            description: "The new time (e.g., '02:00 PM')"
          }
        },
        required: ["appointment_id"]
      }
    }
  },
  {
    type: "function" as const,
    function: {
      name: "end_conversation",
      description: "End the conversation when the user says goodbye or indicates they're done.",
      parameters: {
        type: "object",
        properties: {}
      }
    }
  }
];

const systemPrompt = `You are a helpful AI voice assistant for an appointment scheduling service. You help users:
- Identify themselves by phone number
- View available appointment slots
- Book new appointments
- Retrieve their existing appointments
- Cancel appointments
- Modify appointment times

Important guidelines:
1. Always ask for the user's phone number first to identify them before booking appointments.
2. Phone numbers should be exactly 10 digits. If you hear something that sounds like more or fewer digits, ask them to repeat it slowly.
3. Always confirm the phone number back to the user after they provide it.
4. Be conversational and natural - you're speaking to users via voice.
5. Confirm appointment details (date, time) before booking.
6. Prevent double-booking - if a slot is taken, suggest alternatives.
7. When the user says goodbye or indicates they're done, use the end_conversation tool.
8. Keep responses concise since they will be spoken aloud.
9. If a user isn't identified yet, you can still show available slots, but require identification before booking.

Today's date is ${new Date().toISOString().split('T')[0]}.`;

export async function executeToolCall(
  toolName: string,
  args: Record<string, unknown>,
  context: ConversationContext
): Promise<{ result: string; context: ConversationContext; endCall?: boolean }> {
  let result = "";
  let endCall = false;
  
  switch (toolName) {
    case "identify_user": {
      const phoneNumber = args.phone_number as string;
      const digitsOnly = phoneNumber.replace(/\D/g, "");
      
      if (digitsOnly.length > 10) {
        result = `I heard ${phoneNumber}, but that seems to have more than 10 digits. Could you please repeat your phone number slowly?`;
        break;
      }
      
      if (digitsOnly.length < 10) {
        result = `I heard ${phoneNumber}, but that seems to have fewer than 10 digits. Could you please repeat your complete phone number?`;
        break;
      }
      
      let user = await storage.getUserByPhoneNumber(digitsOnly);
      const formattedPhone = `${digitsOnly.slice(0,3)}-${digitsOnly.slice(3,6)}-${digitsOnly.slice(6)}`;
      
      if (!user) {
        user = await storage.createUser({ phoneNumber: digitsOnly });
        result = `Just to confirm, your phone number is ${formattedPhone}. I've created a new account for you. You don't have any appointments scheduled yet. Would you like to book an appointment?`;
      } else {
        // Automatically retrieve existing appointments for the user
        const appointments = await storage.getAppointmentsByUser(user.id);
        const active = appointments.filter(a => a.status !== "cancelled");
        
        let appointmentInfo: string;
        if (active.length === 0) {
          appointmentInfo = "You don't have any appointments scheduled.";
        } else {
          const list = active.map(a => 
            `${a.date} at ${a.time}${a.description ? ` for ${a.description}` : ""}`
          ).join("; ");
          appointmentInfo = `You have ${active.length} appointment${active.length > 1 ? 's' : ''}: ${list}.`;
        }
        
        result = `Just to confirm, your phone number is ${formattedPhone}. Welcome back${user.name ? ` ${user.name}` : ''}! ${appointmentInfo} Would you like to book a new appointment, or modify or cancel an existing one?`;
      }
      
      context.userId = user.id;
      context.phoneNumber = digitsOnly;
      context.userName = user.name || undefined;
      
      await storage.updateCallSession(context.sessionId, {
        userId: user.id,
        phoneNumber: digitsOnly,
      });
      break;
    }
    
    case "fetch_slots": {
      const dateFilter = args.date as string | undefined;
      const bookedSlots = await storage.getBookedSlots();
      const bookedSet = new Set(bookedSlots.map(s => `${s.date}-${s.time}`));
      
      let available = availableSlots.filter(slot => !bookedSet.has(`${slot.date}-${slot.time}`));
      
      if (dateFilter) {
        available = available.filter(slot => slot.date === dateFilter);
      }
      
      if (available.length === 0) {
        result = dateFilter 
          ? `No available slots on ${dateFilter}. Would you like to check another date?`
          : "No available slots at the moment. Please check back later.";
      } else {
        const slotList = available.slice(0, 5).map(s => `${s.date} at ${s.time}`).join(", ");
        result = `Available slots: ${slotList}${available.length > 5 ? ` and ${available.length - 5} more` : ""}.`;
      }
      break;
    }
    
    case "book_appointment": {
      if (!context.userId) {
        result = "Please provide your phone number first so I can identify you before booking.";
        break;
      }
      
      const date = args.date as string;
      const time = args.time as string;
      const description = args.description as string | undefined;
      
      const bookedSlots = await storage.getBookedSlots();
      const isSlotTaken = bookedSlots.some(s => s.date === date && s.time === time);
      
      if (isSlotTaken) {
        result = `Sorry, the slot on ${date} at ${time} is already booked. Would you like to pick another time?`;
        break;
      }
      
      const isValidSlot = availableSlots.some(s => s.date === date && s.time === time);
      if (!isValidSlot) {
        result = `Sorry, ${date} at ${time} is not an available slot. Let me show you what's available.`;
        break;
      }
      
      const appointment = await storage.createAppointment({
        userId: context.userId,
        date,
        time,
        description,
        status: "scheduled",
      });
      
      result = `Appointment booked successfully for ${date} at ${time}. Your appointment ID is ${appointment.id}.${description ? ` Description: ${description}` : ""}`;
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
        result = "You don't have any appointments scheduled.";
      } else {
        const list = active.map(a => 
          `ID ${a.id}: ${a.date} at ${a.time} (${a.status})${a.description ? ` - ${a.description}` : ""}`
        ).join("; ");
        result = `Your appointments: ${list}`;
      }
      break;
    }
    
    case "cancel_appointment": {
      if (!context.userId) {
        result = "Please provide your phone number first.";
        break;
      }
      
      const appointmentId = args.appointment_id as number;
      const appointment = await storage.getAppointment(appointmentId);
      
      if (!appointment) {
        result = `Appointment ${appointmentId} not found.`;
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
      result = `Appointment ${appointmentId} on ${appointment.date} at ${appointment.time} has been cancelled.`;
      break;
    }
    
    case "modify_appointment": {
      if (!context.userId) {
        result = "Please provide your phone number first.";
        break;
      }
      
      const appointmentId = args.appointment_id as number;
      const newDate = args.new_date as string | undefined;
      const newTime = args.new_time as string | undefined;
      
      if (!newDate && !newTime) {
        result = "Please specify what you'd like to change - the date, time, or both.";
        break;
      }
      
      const appointment = await storage.getAppointment(appointmentId);
      
      if (!appointment) {
        result = `Appointment ${appointmentId} not found.`;
        break;
      }
      
      if (appointment.userId !== context.userId) {
        result = "You can only modify your own appointments.";
        break;
      }
      
      const targetDate = newDate || appointment.date;
      const targetTime = newTime || appointment.time;
      
      const bookedSlots = await storage.getBookedSlots();
      const isSlotTaken = bookedSlots.some(s => 
        s.date === targetDate && s.time === targetTime && 
        !(s.date === appointment.date && s.time === appointment.time)
      );
      
      if (isSlotTaken) {
        result = `Sorry, ${targetDate} at ${targetTime} is already booked.`;
        break;
      }
      
      await storage.updateAppointment(appointmentId, {
        date: targetDate,
        time: targetTime,
        status: "scheduled",
      });
      
      result = `Appointment ${appointmentId} has been rescheduled to ${targetDate} at ${targetTime}.`;
      break;
    }
    
    case "end_conversation": {
      endCall = true;
      result = "Goodbye! Thank you for using our scheduling service.";
      break;
    }
    
    default:
      result = `Unknown tool: ${toolName}`;
  }
  
  return { result, context, endCall };
}

export async function* processVoiceMessage(
  userTranscript: string,
  context: ConversationContext
): AsyncGenerator<{
  type: "user_transcript" | "tool_call_start" | "tool_call_end" | "transcript" | "audio" | "done" | "error";
  data?: string;
  id?: string;
  name?: string;
  parameters?: Record<string, unknown>;
  result?: string;
  endCall?: boolean;
  error?: string;
}> {
  try {
    yield { type: "user_transcript", data: userTranscript };
    
    context.messages.push({ role: "user", content: userTranscript });
    
    const chatMessages = [
      { role: "system" as const, content: systemPrompt },
      ...context.messages.map(m => ({ role: m.role as "user" | "assistant", content: m.content }))
    ];
    
    const response = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: chatMessages,
      tools: toolDefinitions,
      tool_choice: "auto",
    });
    
    const message = response.choices[0]?.message;
    let assistantResponse = message?.content || "";
    let endCall = false;
    
    if (message?.tool_calls && message.tool_calls.length > 0) {
      const toolResults: { tool_call_id: string; content: string }[] = [];
      
      for (const toolCall of message.tool_calls) {
        if (toolCall.type !== "function") continue;
        const toolId = `tool-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
        const toolName = (toolCall as any).function.name;
        const toolArgs = JSON.parse((toolCall as any).function.arguments || "{}");
        
        yield {
          type: "tool_call_start",
          id: toolId,
          name: toolName,
          parameters: toolArgs,
        };
        
        await storage.createToolCall({
          sessionId: context.sessionId,
          toolName,
          parameters: JSON.stringify(toolArgs),
        });
        
        const { result, context: updatedContext, endCall: shouldEnd } = await executeToolCall(
          toolName,
          toolArgs,
          context
        );
        
        context = updatedContext;
        if (shouldEnd) endCall = true;
        
        toolResults.push({
          tool_call_id: toolCall.id,
          content: result,
        });
        
        yield {
          type: "tool_call_end",
          id: toolId,
          name: toolName,
          result,
        };
      }
      
      const followUpMessages = [
        ...chatMessages,
        message,
        ...toolResults.map(tr => ({
          role: "tool" as const,
          tool_call_id: tr.tool_call_id,
          content: tr.content,
        }))
      ];
      
      const audioStream = await openai.chat.completions.create({
        model: "gpt-audio",
        modalities: ["text", "audio"],
        audio: { voice: "alloy", format: "pcm16" },
        messages: followUpMessages as any,
        stream: true,
      });
      
      let fullTranscript = "";
      
      for await (const chunk of audioStream) {
        const delta = chunk.choices?.[0]?.delta as any;
        if (!delta) continue;
        
        if (delta?.audio?.transcript) {
          fullTranscript += delta.audio.transcript;
          yield { type: "transcript", data: delta.audio.transcript };
        }
        
        if (delta?.audio?.data) {
          yield { type: "audio", data: delta.audio.data };
        }
      }
      
      assistantResponse = fullTranscript;
    } else if (assistantResponse) {
      const audioStream = await openai.chat.completions.create({
        model: "gpt-audio",
        modalities: ["text", "audio"],
        audio: { voice: "alloy", format: "pcm16" },
        messages: [
          { role: "system", content: "You are a helpful voice assistant. Speak naturally." },
          { role: "user", content: `Please say the following naturally: ${assistantResponse}` }
        ],
        stream: true,
      });
      
      for await (const chunk of audioStream) {
        const delta = chunk.choices?.[0]?.delta as any;
        if (!delta) continue;
        
        if (delta?.audio?.transcript) {
          yield { type: "transcript", data: delta.audio.transcript };
        }
        
        if (delta?.audio?.data) {
          yield { type: "audio", data: delta.audio.data };
        }
      }
    }
    
    if (assistantResponse) {
      context.messages.push({ role: "assistant", content: assistantResponse });
    }
    
    yield { type: "done", endCall };
    
  } catch (error) {
    console.error("Voice processing error:", error);
    yield { type: "error", error: error instanceof Error ? error.message : "Unknown error" };
  }
}

export async function generateCallSummary(sessionId: number, transcript?: string): Promise<{
  summary: string;
  appointments: { id: number; date: string; time: string; description?: string; status: string }[];
  userPreferences: string[];
  userName?: string;
  phoneNumber?: string;
  newAppointmentsCreated?: number;
}> {
  const session = await storage.getCallSession(sessionId);
  const toolCallsData = await storage.getToolCallsBySession(sessionId);
  
  let user = null;
  if (session?.userId) {
    user = await storage.getUser(session.userId);
  }
  
  const toolSummary = toolCallsData.map(tc => 
    `${tc.toolName}: ${tc.parameters || ''} -> ${tc.result || 'completed'}`
  ).join('\n');
  
  // First, extract user info and appointments from transcript
  const extractionPrompt = `Analyze this voice call transcript and extract appointment booking information.

CONVERSATION TRANSCRIPT:
${transcript || "No transcript available"}

Extract the following information in JSON format:
{
  "userName": "The caller's name if mentioned",
  "phoneNumber": "The caller's phone number if mentioned (digits only, no formatting)",
  "appointmentRequests": [
    {
      "date": "YYYY-MM-DD format date if a specific date was discussed",
      "time": "Time in format like '9:00 AM', '2:30 PM' if discussed",
      "description": "What the appointment is for (e.g., 'dental checkup', 'consultation')"
    }
  ],
  "cancellationRequests": [
    {
      "date": "Date of appointment to cancel if mentioned",
      "time": "Time of appointment to cancel if mentioned"
    }
  ],
  "summary": "A 2-3 sentence summary of what was discussed and accomplished",
  "userPreferences": ["Any preferences mentioned like preferred times, special needs, etc."]
}

IMPORTANT:
- Only include appointment requests where the user clearly confirmed they want to book
- If user just asked about availability but didn't confirm booking, don't include it
- Phone numbers should be 10 digits only, remove any formatting
- Dates should be in YYYY-MM-DD format (assume current year 2026 if not specified)
- Return empty arrays if no appointments/cancellations were confirmed`;

  try {
    // Use Groq's Llama model if GROQ_API_KEY is set, otherwise use OpenAI
    const model = process.env.GROQ_API_KEY ? "llama-3.3-70b-versatile" : "gpt-4o-mini";
    
    const extractionResponse = await openai.chat.completions.create({
      model: model,
      messages: [
        { role: "system", content: "You are a precise data extraction assistant. Extract appointment information from call transcripts. Always respond with valid JSON." },
        { role: "user", content: extractionPrompt }
      ],
      max_completion_tokens: 800,
      response_format: { type: "json_object" },
    });
    
    const responseText = extractionResponse.choices[0]?.message?.content || '{}';
    let extractedData;
    try {
      extractedData = JSON.parse(responseText);
    } catch {
      extractedData = { summary: "Call completed.", appointmentRequests: [], userPreferences: [] };
    }
    
    console.log("Extracted data from transcript:", JSON.stringify(extractedData));
    
    // Helper to normalize time format for comparison (e.g., "9:00 AM" -> "09:00 AM")
    const normalizeTime = (time: string): string => {
      const match = time.match(/^(\d{1,2}):(\d{2})\s*(AM|PM|am|pm)?$/i);
      if (!match) return time.toLowerCase().trim();
      const hour = match[1].padStart(2, '0');
      const min = match[2];
      const period = (match[3] || '').toUpperCase();
      return `${hour}:${min} ${period}`.trim();
    };
    
    // Get or create user from extracted info
    const extractedPhone = extractedData.phoneNumber?.replace(/\D/g, '') || session?.phoneNumber;
    const extractedName = extractedData.userName || user?.name;
    
    // Handle user identification - prefer existing session user, but also try transcript data
    if (!user && extractedPhone && extractedPhone.length >= 10) {
      const existingUser = await storage.getUserByPhoneNumber(extractedPhone);
      if (existingUser) {
        user = existingUser;
        if (extractedName && !existingUser.name) {
          await storage.updateUser(existingUser.id, { name: extractedName });
          user = { ...existingUser, name: extractedName };
        }
      } else {
        user = await storage.createUser({ 
          phoneNumber: extractedPhone, 
          name: extractedName || undefined 
        });
        console.log("Created new user from transcript:", user.id, user.name);
      }
    } else if (user && extractedName && !user.name) {
      // Update existing user's name if we extracted one
      await storage.updateUser(user.id, { name: extractedName });
      user = { ...user, name: extractedName };
    }
    
    // Get existing appointments BEFORE creating new ones (for duplicate detection)
    const existingAppts = user ? await storage.getAppointmentsByUser(user.id) : [];
    
    // Create appointments from extracted requests (with duplicate protection)
    let newAppointmentsCreated = 0;
    if (user && extractedData.appointmentRequests?.length > 0) {
      for (const apptRequest of extractedData.appointmentRequests) {
        if (apptRequest.date && apptRequest.time) {
          // Check for duplicate: same user, date, and normalized time
          const normalizedReqTime = normalizeTime(apptRequest.time);
          const isDuplicate = existingAppts.some(a => 
            a.date === apptRequest.date && 
            normalizeTime(a.time) === normalizedReqTime &&
            a.status !== "cancelled"
          );
          
          if (isDuplicate) {
            console.log("Skipping duplicate appointment:", apptRequest.date, apptRequest.time);
            continue;
          }
          
          try {
            const newAppt = await storage.createAppointment({
              userId: user.id,
              date: apptRequest.date,
              time: apptRequest.time,
              description: apptRequest.description || "Appointment booked via voice call",
              status: "pending"
            });
            existingAppts.push(newAppt); // Add to list for subsequent duplicate checks
            newAppointmentsCreated++;
            console.log("Created appointment from transcript:", newAppt.id, apptRequest.date, apptRequest.time);
          } catch (apptError) {
            console.error("Error creating appointment:", apptError);
          }
        }
      }
    }
    
    // Process cancellation requests (with normalized time matching)
    if (extractedData.cancellationRequests?.length > 0 && !user) {
      console.warn("Warning: Cancellation requests found but no user identified - cancellations will not be applied:", 
        extractedData.cancellationRequests);
    }
    if (user && extractedData.cancellationRequests?.length > 0) {
      const userAppts = await storage.getAppointmentsByUser(user.id);
      for (const cancelReq of extractedData.cancellationRequests) {
        const normalizedCancelTime = normalizeTime(cancelReq.time || '');
        const matchingAppt = userAppts.find(a => 
          a.date === cancelReq.date && 
          normalizeTime(a.time) === normalizedCancelTime &&
          a.status !== "cancelled"
        );
        if (matchingAppt) {
          await storage.updateAppointment(matchingAppt.id, { status: "cancelled" });
          console.log("Cancelled appointment from transcript:", matchingAppt.id);
        } else {
          console.log("No matching appointment found to cancel:", cancelReq.date, cancelReq.time);
        }
      }
    }
    
    // Get updated appointments list
    const appointments = user 
      ? (await storage.getAppointmentsByUser(user.id)).map(a => ({
          id: a.id,
          date: a.date,
          time: a.time,
          description: a.description || undefined,
          status: a.status,
        }))
      : [];
    
    const summary = extractedData.summary || "Call completed.";
    const userPreferences = extractedData.userPreferences || [];
    
    // Store transcript and summary in database
    await storage.endCallSession(
      sessionId,
      summary + (newAppointmentsCreated > 0 ? ` (${newAppointmentsCreated} appointment(s) created)` : ''),
      JSON.stringify(appointments),
      JSON.stringify(userPreferences),
      transcript
    );
    
    return {
      summary: summary + (newAppointmentsCreated > 0 ? ` ${newAppointmentsCreated} appointment(s) were automatically created from this conversation.` : ''),
      appointments,
      userPreferences,
      userName: extractedName || undefined,
      phoneNumber: extractedPhone || undefined,
      newAppointmentsCreated,
    };
  } catch (error) {
    console.error("Error generating summary:", error);
    
    // Fallback - get existing appointments
    const appointments = user 
      ? (await storage.getAppointmentsByUser(user.id)).map(a => ({
          id: a.id,
          date: a.date,
          time: a.time,
          description: a.description || undefined,
          status: a.status,
        }))
      : [];
    
    const fallbackSummary = transcript 
      ? "Call completed. Transcript has been saved."
      : "Call completed.";
    
    await storage.endCallSession(
      sessionId,
      fallbackSummary,
      JSON.stringify(appointments),
      "[]",
      transcript
    );
    
    return {
      summary: fallbackSummary,
      appointments,
      userPreferences: [],
      userName: user?.name || undefined,
      phoneNumber: session?.phoneNumber || undefined,
    };
  }
}
