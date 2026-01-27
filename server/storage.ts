import { 
  users, 
  appointments, 
  callSessions, 
  toolCalls,
  conversations,
  messages,
  type User, 
  type InsertUser,
  type Appointment,
  type InsertAppointment,
  type CallSession,
  type InsertCallSession,
  type ToolCall,
  type InsertToolCall,
  type Conversation,
  type Message,
  type InsertConversation,
  type InsertMessage,
  availableSlots,
} from "@shared/schema";
import { db } from "./db";
import { eq, desc, and, ne } from "drizzle-orm";

export interface IStorage {
  getUser(id: number): Promise<User | undefined>;
  getUserByPhoneNumber(phoneNumber: string): Promise<User | undefined>;
  createUser(user: InsertUser): Promise<User>;
  updateUser(id: number, data: Partial<InsertUser>): Promise<User | undefined>;

  getAppointment(id: number): Promise<Appointment | undefined>;
  getAppointmentsByUser(userId: number): Promise<Appointment[]>;
  getAllAppointments(): Promise<Appointment[]>;
  createAppointment(appointment: InsertAppointment): Promise<Appointment>;
  updateAppointment(id: number, data: Partial<InsertAppointment>): Promise<Appointment | undefined>;
  cancelAppointment(id: number): Promise<Appointment | undefined>;
  getBookedSlots(): Promise<{ date: string; time: string }[]>;

  getCallSession(id: number): Promise<CallSession | undefined>;
  createCallSession(session: InsertCallSession): Promise<CallSession>;
  updateCallSession(id: number, data: Partial<CallSession>): Promise<CallSession | undefined>;
  endCallSession(id: number, summary: string, bookedAppointments?: string, userPreferences?: string, transcript?: string): Promise<CallSession | undefined>;

  createToolCall(toolCall: InsertToolCall): Promise<ToolCall>;
  getToolCallsBySession(sessionId: number): Promise<ToolCall[]>;

  getConversation(id: number): Promise<Conversation | undefined>;
  getAllConversations(): Promise<Conversation[]>;
  createConversation(title: string): Promise<Conversation>;
  deleteConversation(id: number): Promise<void>;
  getMessagesByConversation(conversationId: number): Promise<Message[]>;
  createMessage(conversationId: number, role: string, content: string): Promise<Message>;
}

export class DatabaseStorage implements IStorage {
  async getUser(id: number): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.id, id));
    return user || undefined;
  }

  async getUserByPhoneNumber(phoneNumber: string): Promise<User | undefined> {
    const [user] = await db.select().from(users).where(eq(users.phoneNumber, phoneNumber));
    return user || undefined;
  }

  async createUser(insertUser: InsertUser): Promise<User> {
    const [user] = await db.insert(users).values(insertUser).returning();
    return user;
  }

  async updateUser(id: number, data: Partial<InsertUser>): Promise<User | undefined> {
    const [user] = await db.update(users).set(data).where(eq(users.id, id)).returning();
    return user || undefined;
  }

  async getAppointment(id: number): Promise<Appointment | undefined> {
    const [appointment] = await db.select().from(appointments).where(eq(appointments.id, id));
    return appointment || undefined;
  }

  async getAppointmentsByUser(userId: number): Promise<Appointment[]> {
    return db.select().from(appointments)
      .where(eq(appointments.userId, userId))
      .orderBy(desc(appointments.createdAt));
  }

  async getAllAppointments(): Promise<Appointment[]> {
    return db.select().from(appointments).orderBy(desc(appointments.createdAt));
  }

  async createAppointment(appointment: InsertAppointment): Promise<Appointment> {
    const [created] = await db.insert(appointments).values(appointment).returning();
    return created;
  }

  async updateAppointment(id: number, data: Partial<InsertAppointment>): Promise<Appointment | undefined> {
    const [updated] = await db.update(appointments).set(data).where(eq(appointments.id, id)).returning();
    return updated || undefined;
  }

  async cancelAppointment(id: number): Promise<Appointment | undefined> {
    const [cancelled] = await db.update(appointments)
      .set({ status: "cancelled" })
      .where(eq(appointments.id, id))
      .returning();
    return cancelled || undefined;
  }

  async getBookedSlots(): Promise<{ date: string; time: string }[]> {
    const booked = await db.select({ date: appointments.date, time: appointments.time })
      .from(appointments)
      .where(ne(appointments.status, "cancelled"));
    return booked;
  }

  async getCallSession(id: number): Promise<CallSession | undefined> {
    const [session] = await db.select().from(callSessions).where(eq(callSessions.id, id));
    return session || undefined;
  }

  async createCallSession(session: InsertCallSession): Promise<CallSession> {
    const [created] = await db.insert(callSessions).values(session).returning();
    return created;
  }

  async updateCallSession(id: number, data: Partial<CallSession>): Promise<CallSession | undefined> {
    const [updated] = await db.update(callSessions).set(data).where(eq(callSessions.id, id)).returning();
    return updated || undefined;
  }

  async endCallSession(id: number, summary: string, bookedAppointments?: string, userPreferences?: string, transcript?: string): Promise<CallSession | undefined> {
    const [ended] = await db.update(callSessions)
      .set({ 
        status: "ended", 
        summary, 
        bookedAppointments,
        userPreferences,
        transcript,
        endedAt: new Date() 
      })
      .where(eq(callSessions.id, id))
      .returning();
    return ended || undefined;
  }

  async createToolCall(toolCall: InsertToolCall): Promise<ToolCall> {
    const [created] = await db.insert(toolCalls).values(toolCall).returning();
    return created;
  }

  async getToolCallsBySession(sessionId: number): Promise<ToolCall[]> {
    return db.select().from(toolCalls)
      .where(eq(toolCalls.sessionId, sessionId))
      .orderBy(toolCalls.createdAt);
  }

  async getConversation(id: number): Promise<Conversation | undefined> {
    const [conversation] = await db.select().from(conversations).where(eq(conversations.id, id));
    return conversation;
  }

  async getAllConversations(): Promise<Conversation[]> {
    return db.select().from(conversations).orderBy(desc(conversations.createdAt));
  }

  async createConversation(title: string): Promise<Conversation> {
    const [conversation] = await db.insert(conversations).values({ title }).returning();
    return conversation;
  }

  async deleteConversation(id: number): Promise<void> {
    await db.delete(messages).where(eq(messages.conversationId, id));
    await db.delete(conversations).where(eq(conversations.id, id));
  }

  async getMessagesByConversation(conversationId: number): Promise<Message[]> {
    return db.select().from(messages).where(eq(messages.conversationId, conversationId)).orderBy(messages.createdAt);
  }

  async createMessage(conversationId: number, role: string, content: string): Promise<Message> {
    const [message] = await db.insert(messages).values({ conversationId, role, content }).returning();
    return message;
  }
}

export const storage = new DatabaseStorage();
