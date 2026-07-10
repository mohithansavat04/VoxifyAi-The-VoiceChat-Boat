# Voxify AI API Documentation

Welcome to the Voxify AI Developer API! This documentation explains how your developers can integrate Voxify's AI Voice Agents directly into your CRM, ERP, or internal software.

## Base URL
All API requests should be made to your Voxify SaaS domain (e.g., `https://your-voxify-domain.com`). 

*(For local testing, use `http://localhost:3000`)*

## Authentication
All API requests require your unique **API Key**. 
You can find this in your Voxify Dashboard by clicking on "Copy API Key".

Include the API Key in the `Authorization` header of every request as a Bearer token:
```http
Authorization: Bearer YOUR_API_KEY
```

---

## 1. Initiate an Outbound AI Call
Trigger an automated AI voice agent to call a specific phone number. The call will be routed through the Telecom Provider you have configured in your dashboard (Twilio or Exotel).

**Endpoint:** `POST /api/v1/call`

### Request Headers
```json
{
  "Authorization": "Bearer YOUR_API_KEY",
  "Content-Type": "application/json"
}
```

### Request Body
```json
{
  "targetPhone": "+919876543210" 
}
```
*Note: Include the country code (e.g., `+91` or `+1`).*

### Response (200 OK)
```json
{
  "message": "Call initiated successfully via Exotel",
  "callId": "65b2a3f9e4b0a1b2c3d4e5f6",
  "exotelCallSid": "ca1234567890abcdef",
  "targetPhone": "+919876543210",
  "status": "In Progress"
}
```

### Response (Error Examples)
- **401 Unauthorized**: Invalid or missing API Key.
- **403 Forbidden**: Trial minutes exhausted or account suspended.
- **500 Server Error**: Telecom credentials not configured in your dashboard.

---

## 2. Get Call History & Extracted Data
Fetch a list of all past AI calls, including the full conversation transcript and the data extracted by the AI (based on your Qualification Criteria).

**Endpoint:** `GET /api/v1/calls`

### Request Headers
```json
{
  "Authorization": "Bearer YOUR_API_KEY"
}
```

### Response (200 OK)
```json
[
  {
    "_id": "65b2a3f9e4b0a1b2c3d4e5f6",
    "targetPhone": "+919876543210",
    "status": "Completed",
    "durationMinutes": 2,
    "transcript": "AI: Hello...\nUser: Hi...",
    "extractedData": {
      "What is their name?": "Mohit",
      "What is their current city?": "Delhi"
    },
    "recordingUrl": "https://api.twilio.com/2010-04-01/Accounts/.../Recordings/....mp3",
    "createdAt": "2024-05-12T10:00:00Z"
  }
]
```

---

## Webhook: Receiving Real-Time Updates (Coming Soon)
Currently, to get the extracted data, you should poll `GET /api/v1/calls` after the call finishes. Future updates will allow you to register a Webhook URL to receive the `extractedData` automatically the moment the user hangs up the phone!
