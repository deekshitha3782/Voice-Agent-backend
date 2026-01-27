import { sql, relations } from "drizzle-orm";
import { pgTable, text, varchar, serial, integer, timestamp, boolean } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  phoneNumber: varchar("phone_number", { length: 20 }).notNull().unique(),
  name: text("name"),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
});

export const usersRelations = relations(users, ({ many }) => ({
  appointments: many(appointments),
  callSessions: many(callSessions),
}));

export const appointments = pgTable("appointments", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  date: text("date").notNull(),
  time: text("time").notNull(),
  description: text("description"),
  status: text("status").notNull().default("scheduled"),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
});

export const appointmentsRelations = relations(appointments, ({ one }) => ({
  user: one(users, {
    fields: [appointments.userId],
    references: [users.id],
  }),
}));

export const callSessions = pgTable("call_sessions", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").references(() => users.id),
  phoneNumber: varchar("phone_number", { length: 20 }),
  status: text("status").notNull().default("active"),
  transcript: text("transcript"),
  summary: text("summary"),
  bookedAppointments: text("booked_appointments"),
  userPreferences: text("user_preferences"),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
  endedAt: timestamp("ended_at"),
});

export const callSessionsRelations = relations(callSessions, ({ one, many }) => ({
  user: one(users, {
    fields: [callSessions.userId],
    references: [users.id],
  }),
  toolCalls: many(toolCalls),
}));

export const toolCalls = pgTable("tool_calls", {
  id: serial("id").primaryKey(),
  sessionId: integer("session_id").notNull().references(() => callSessions.id, { onDelete: "cascade" }),
  toolName: text("tool_name").notNull(),
  parameters: text("parameters"),
  result: text("result"),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
});

export const toolCallsRelations = relations(toolCalls, ({ one }) => ({
  session: one(callSessions, {
    fields: [toolCalls.sessionId],
    references: [callSessions.id],
  }),
}));

export const conversations = pgTable("conversations", {
  id: serial("id").primaryKey(),
  title: text("title").notNull(),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
});

export const messages = pgTable("messages", {
  id: serial("id").primaryKey(),
  conversationId: integer("conversation_id").notNull().references(() => conversations.id, { onDelete: "cascade" }),
  role: text("role").notNull(),
  content: text("content").notNull(),
  createdAt: timestamp("created_at").default(sql`CURRENT_TIMESTAMP`).notNull(),
});

export const insertUserSchema = createInsertSchema(users).omit({
  id: true,
  createdAt: true,
});

export const insertAppointmentSchema = createInsertSchema(appointments).omit({
  id: true,
  createdAt: true,
});

export const insertCallSessionSchema = createInsertSchema(callSessions).omit({
  id: true,
  createdAt: true,
  endedAt: true,
});

export const insertToolCallSchema = createInsertSchema(toolCalls).omit({
  id: true,
  createdAt: true,
});

export const insertConversationSchema = createInsertSchema(conversations).omit({
  id: true,
  createdAt: true,
});

export const insertMessageSchema = createInsertSchema(messages).omit({
  id: true,
  createdAt: true,
});

export type User = typeof users.$inferSelect;
export type InsertUser = z.infer<typeof insertUserSchema>;
export type Appointment = typeof appointments.$inferSelect;
export type InsertAppointment = z.infer<typeof insertAppointmentSchema>;
export type CallSession = typeof callSessions.$inferSelect;
export type InsertCallSession = z.infer<typeof insertCallSessionSchema>;
export type ToolCall = typeof toolCalls.$inferSelect;
export type InsertToolCall = z.infer<typeof insertToolCallSchema>;
export type Conversation = typeof conversations.$inferSelect;
export type Message = typeof messages.$inferSelect;
export type InsertConversation = z.infer<typeof insertConversationSchema>;
export type InsertMessage = z.infer<typeof insertMessageSchema>;

export const availableSlots = [
  { date: "2026-01-28", time: "09:00 AM" },
  { date: "2026-01-28", time: "10:00 AM" },
  { date: "2026-01-28", time: "02:00 PM" },
  { date: "2026-01-28", time: "03:00 PM" },
  { date: "2026-01-29", time: "09:00 AM" },
  { date: "2026-01-29", time: "11:00 AM" },
  { date: "2026-01-29", time: "01:00 PM" },
  { date: "2026-01-29", time: "04:00 PM" },
  { date: "2026-01-30", time: "10:00 AM" },
  { date: "2026-01-30", time: "02:00 PM" },
  { date: "2026-01-30", time: "03:30 PM" },
  { date: "2026-01-31", time: "09:00 AM" },
  { date: "2026-01-31", time: "11:30 AM" },
  { date: "2026-01-31", time: "02:00 PM" },
  { date: "2026-02-01", time: "10:00 AM" },
  { date: "2026-02-01", time: "01:00 PM" },
  { date: "2026-02-01", time: "03:00 PM" },
];
