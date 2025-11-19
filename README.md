# BinaryBond - P2P Communication App

A peer-to-peer real-time communication application with text chat, voice, and video calling. Features a sleek ThinkPad-inspired dark theme.

## Features

- **Text Chat**: Real-time messaging via WebRTC data channels
- **Voice Calling**: High-quality audio communication
- **Video Calling**: Face-to-face video chat
- **No External Services**: Runs completely locally with a simple signaling server
- **Dark Theme**: Professional ThinkPad-inspired aesthetic

## Requirements

- Node.js (v14 or higher)
- Modern web browser with WebRTC support (Chrome, Firefox, Edge, Safari)
- Camera and microphone for video/voice features

## Installation & Setup

1. **Extract the files** to a folder on your computer

2. **Install dependencies**:
   ```bash
   npm install
   ```

3. **Start the application**:
   - **Windows**: Double-click `start.bat`
   - **Mac/Linux**: Run `chmod +x start.sh && ./start.sh`
   - **Manual**: Run `npm start`

4. **Open your browser** and go to `http://localhost:3000`

## How to Use

### Creating a Connection

1. **Person 1** (Room Creator):
   - Click "Create Room"
   - Copy the generated room code
   - Share it with your friend

2. **Person 2** (Room Joiner):
   - Enter the room code
   - Click "Join Room"

3. Both users will be connected automatically!

### Using Over Internet

The app works on both LAN and internet connections:

- **LAN**: Both users connect to `http://<host-ip>:3000`
- **Internet**: You'll need to:
  1. Forward port 3000 on your router
  2. Share your public IP with your friend
  3. Or use a tunneling service like ngrok

### Controls

- **Video Toggle**: Turn camera on/off
- **Audio Toggle**: Mute/unmute microphone
- **End Call**: Disconnect from the session
- **Chat**: Type messages and press Enter or click Send

## File Structure

```
binarybond/
├── index.html      # Main UI
├── style.css       # ThinkPad-inspired theme
├── script.js       # WebRTC and app logic
├── server.js       # Signaling server
├── package.json    # Dependencies
├── start.bat       # Windows launcher
├── start.sh        # Mac/Linux launcher
└── README.md       # This file
```

## Troubleshooting

- **Camera/Mic not working**: Check browser permissions
- **Can't connect**: Ensure both users are using the same server URL
- **Server won't start**: Make sure Node.js is installed and port 3000 is free
- **Connection drops**: Check your network stability

## Technical Details

- Uses WebRTC for peer-to-peer connections
- Minimal WebSocket signaling server for connection setup
- STUN servers for NAT traversal
- No data is stored on any server
- All communication is direct between peers

## Privacy & Security

- No data is stored or logged
- All communication is peer-to-peer
- Video/audio streams are not recorded
- Room codes expire when users disconnect