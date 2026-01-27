# AI Voice Agent - Backend API

Express.js backend for the AI Voice Agent appointment booking system.

## Quick Start

```bash
npm install
npm run db:push
npm run dev
```

Server runs on http://localhost:5000

## Environment Variables

```bash
DATABASE_URL=postgresql://user:password@host:5432/database
BEY_API_KEY=your_beyond_presence_key
OPENAI_API_KEY=your_openai_key
SESSION_SECRET=random_secret_string
PORT=5000
```

## API Endpoints

- `POST /api/bey/call` - Start video call
- `POST /api/users/lookup` - Lookup user by phone
- `POST /api/appointments` - Create appointment
- `GET /api/appointments/:userId` - Get user appointments
- `DELETE /api/appointments/:id` - Cancel appointment

## Deployment

### Railway
1. Connect GitHub repo to Railway
2. Add PostgreSQL addon
3. Set environment variables
4. Deploy

### Render
1. Create Web Service from GitHub
2. Set build command: `npm install && npm run build`
3. Set start command: `npm start`
4. Connect PostgreSQL database
5. Deploy

## License

MIT
