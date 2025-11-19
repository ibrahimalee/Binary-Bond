// BinaryBond - P2P Communication App
class BinaryBond {
    constructor() {
        this.pc = null;
        this.localStream = null;
        this.remoteStream = null;
        this.roomCode = null;
        this.isCreator = false;
        this.dataChannel = null;
        this.recentRooms = this.loadRecentRooms();
        this.callTimer = null;
        this.callStartTime = null;
        this.focusModeEnabled = false;
        this.pollers = {
            offer: null,
            answer: null,
            ice: null
        };
        this.hasRemoteOffer = false;
        this.hasRemoteAnswer = false;
        this.receivedIceSignatures = new Set();
        this.inCallView = false;
        
        this.init();
    }

    startOfferPolling() {
        if (this.isCreator) return;
        this.stopOfferPolling();
        this.pollers.offer = setInterval(() => this.checkForOffer(), 1000);
        this.checkForOffer();
    }

    stopOfferPolling() {
        if (this.pollers.offer) {
            clearInterval(this.pollers.offer);
            this.pollers.offer = null;
        }
    }

    async checkForOffer() {
        if (this.hasRemoteOffer || !this.roomCode || !this.pc) return;
        try {
            const result = await Parse.Cloud.run('getOffer', { code: this.roomCode });
            const offer = result?.offer;
            if (offer) {
                await this.handleOffer(offer);
                this.stopOfferPolling();
            }
        } catch (error) {
            console.error('Error polling for offer:', error);
        }
    }

    startAnswerPolling() {
        if (!this.isCreator) return;
        this.stopAnswerPolling();
        this.pollers.answer = setInterval(() => this.checkForAnswer(), 1000);
        this.checkForAnswer();
    }

    stopAnswerPolling() {
        if (this.pollers.answer) {
            clearInterval(this.pollers.answer);
            this.pollers.answer = null;
        }
    }

    async checkForAnswer() {
        if (this.hasRemoteAnswer || !this.roomCode || !this.pc) return;
        try {
            const result = await Parse.Cloud.run('getAnswer', { code: this.roomCode });
            const answer = result?.answer;
            if (answer) {
                await this.handleAnswer(answer);
                this.stopAnswerPolling();
            }
        } catch (error) {
            console.error('Error polling for answer:', error);
        }
    }

    startIcePolling() {
        this.stopIcePolling();
        this.pollers.ice = setInterval(() => this.checkForIce(), 1000);
        this.checkForIce();
    }

    stopIcePolling() {
        if (this.pollers.ice) {
            clearInterval(this.pollers.ice);
            this.pollers.ice = null;
        }
    }

    async checkForIce() {
        if (!this.roomCode || !this.pc) return;
        try {
            const response = await Parse.Cloud.run('getIce', { code: this.roomCode });
            const candidates = Array.isArray(response)
                ? response
                : (Array.isArray(response?.candidates) ? response.candidates : []);

            for (const candidate of candidates) {
                const signature = JSON.stringify(candidate);
                if (this.receivedIceSignatures.has(signature)) continue;
                this.receivedIceSignatures.add(signature);
                await this.handleIceCandidate(candidate);
            }
        } catch (error) {
            console.error('Error polling ICE candidates:', error);
        }
    }

    stopAllPolling() {
        this.stopOfferPolling();
        this.stopAnswerPolling();
        this.stopIcePolling();
    }

    init() {
        // DOM Elements
        this.elements = {
            connectionPanel: document.getElementById('connectionPanel'),
            communicationPanel: document.getElementById('communicationPanel'),
            connectionStatus: document.getElementById('connectionStatus'),
            createRoomBtn: document.getElementById('createRoomBtn'),
            joinRoomBtn: document.getElementById('joinRoomBtn'),
            roomCodeInput: document.getElementById('roomCodeInput'),
            roomInfo: document.getElementById('roomInfo'),
            roomCode: document.getElementById('roomCode'),
            copyCodeBtn: document.getElementById('copyCodeBtn'),
            localVideo: document.getElementById('localVideo'),
            remoteVideo: document.getElementById('remoteVideo'),
            toggleVideoBtn: document.getElementById('toggleVideoBtn'),
            toggleAudioBtn: document.getElementById('toggleAudioBtn'),
            endCallBtn: document.getElementById('endCallBtn'),
            chatMessages: document.getElementById('chatMessages'),
            chatInput: document.getElementById('chatInput'),
            sendBtn: document.getElementById('sendBtn'),
            recentRooms: document.getElementById('recentRooms'),
            recentRoomList: document.getElementById('recentRoomList'),
            clearHistoryBtn: document.getElementById('clearHistoryBtn'),
            callInsights: document.getElementById('callInsights'),
            callDuration: document.getElementById('callDuration'),
            callRole: document.getElementById('callRole'),
            focusModeBtn: document.getElementById('focusModeBtn')
        };

        // Event Listeners
        this.elements.createRoomBtn.addEventListener('click', () => this.createRoom());
        this.elements.joinRoomBtn.addEventListener('click', () => this.joinRoom());
        this.elements.copyCodeBtn.addEventListener('click', () => this.copyRoomCode());
        this.elements.toggleVideoBtn.addEventListener('click', () => this.toggleVideo());
        this.elements.toggleAudioBtn.addEventListener('click', () => this.toggleAudio());
        this.elements.endCallBtn.addEventListener('click', () => this.endCall());
        this.elements.sendBtn.addEventListener('click', () => this.sendMessage());
        this.elements.focusModeBtn.addEventListener('click', () => this.toggleFocusMode());
        this.elements.clearHistoryBtn.addEventListener('click', () => this.clearRecentRooms());
        this.elements.recentRoomList.addEventListener('click', (event) => this.handleRecentRoomClick(event));
        this.elements.chatInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault(); // prevent newline
                this.sendMessage();
            }
        });
        

        this.renderRecentRooms();
    }

    async createRoom() {
        try {
            this.isCreator = true;
            const response = await Parse.Cloud.run('createRoom');
            const generatedCode = response?.code || response?.roomCode;
            if (!generatedCode) {
                throw new Error('Room code not returned');
            }
            this.roomCode = generatedCode.toUpperCase();
            this.handleRoomCreated(this.roomCode);
            await this.prepareConnectionEnvironment();
            await this.createOffer();
            this.startAnswerPolling();
            this.startIcePolling();
        } catch (error) {
            console.error('Error creating room:', error);
            alert('Unable to create room right now. Please try again.');
        }
    }

    async joinRoom() {
        const roomCode = this.elements.roomCodeInput.value.trim().toUpperCase();
        if (!roomCode) {
            alert('Please enter a room code');
            return;
        }

        this.roomCode = roomCode;
        this.isCreator = false;

        try {
            await this.enterCallView();
            this.startOfferPolling();
            this.startIcePolling();
        } catch (error) {
            console.error('Error joining room:', error);
            alert('Unable to join this room. Please verify the code and try again.');
        }
    }

    handleRoomCreated(roomCode) {
        this.roomCode = roomCode;
        this.elements.roomCode.textContent = roomCode;
        this.elements.roomInfo.style.display = 'block';
        this.updateConnectionStatus('Waiting for peer...');
        this.saveRoomToHistory(roomCode);
    }

    async prepareConnectionEnvironment() {
        if (this.pc) return;
        await this.setupMedia();
        await this.createPeerConnection();
    }

    async enterCallView() {
        if (!this.roomCode) return;
        await this.prepareConnectionEnvironment();
        if (this.inCallView) return;

        this.elements.connectionPanel.style.display = 'none';
        this.elements.communicationPanel.style.display = 'flex';
        this.updateConnectionStatus('Connected');
        this.saveRoomToHistory(this.roomCode);
        this.updateCallRole();
        this.startCallTimer();
        this.toggleCallInsights(true);
        this.inCallView = true;
    }

    async setupMedia() {
        try {
            this.localStream = await navigator.mediaDevices.getUserMedia({
                video: true,
                audio: true
            });
            
            this.elements.localVideo.srcObject = this.localStream;
        } catch (error) {
            console.error('Error accessing media devices:', error);
            alert('Failed to access camera/microphone. Please check permissions.');
        }
    }

    async createPeerConnection() {
        const configuration = {
            iceServers: [
                { urls: 'stun:stun.l.google.com:19302' },
                { urls: 'stun:stun1.l.google.com:19302' }
            ]
        };

        this.pc = new RTCPeerConnection(configuration);

        // Add local stream
        if (this.localStream) {
            this.localStream.getTracks().forEach(track => {
                this.pc.addTrack(track, this.localStream);
            });
        }

        // Handle remote stream
        this.pc.ontrack = (event) => {
            if (!this.remoteStream) {
                this.remoteStream = new MediaStream();
                this.elements.remoteVideo.srcObject = this.remoteStream;
            }
            this.remoteStream.addTrack(event.track);
        };

        // Handle ICE candidates
        this.pc.onicecandidate = async (event) => {
            if (event.candidate && this.roomCode) {
                try {
                    await Parse.Cloud.run('addIce', {
                        code: this.roomCode,
                        candidate: event.candidate
                    });
                } catch (error) {
                    console.error('Error sending ICE candidate:', error);
                }
            }
        };

        this.pc.onconnectionstatechange = () => {
            if (!this.roomCode) return;
            const state = this.pc.connectionState;
            if (['failed', 'disconnected'].includes(state)) {
                this.handlePeerDisconnected();
            }
        };

        // Setup data channel for text chat
        if (this.isCreator) {
            this.dataChannel = this.pc.createDataChannel('chat');
            this.setupDataChannel();
        } else {
            this.pc.ondatachannel = (event) => {
                this.dataChannel = event.channel;
                this.setupDataChannel();
            };
        }
    }

    setupDataChannel() {
        this.dataChannel.onopen = () => {
            console.log('Data channel opened');
        };

        this.dataChannel.onmessage = (event) => {
            this.displayMessage(event.data, false);
        };

        this.dataChannel.onerror = (error) => {
            console.error('Data channel error:', error);
        };

        this.dataChannel.onclose = () => {
            console.log('Data channel closed');
        };
    }

    async createOffer() {
        try {
            const offer = await this.pc.createOffer();
            await this.pc.setLocalDescription(offer);

            await Parse.Cloud.run('submitOffer', {
                code: this.roomCode,
                offer
            });
        } catch (error) {
            console.error('Error creating offer:', error);
            alert('Unable to create an offer. Please try again.');
        }
    }

    async handleOffer(offer) {
        try {
            await this.pc.setRemoteDescription(new RTCSessionDescription(offer));
            const answer = await this.pc.createAnswer();
            await this.pc.setLocalDescription(answer);

            await Parse.Cloud.run('submitAnswer', {
                code: this.roomCode,
                answer
            });
            this.hasRemoteOffer = true;
        } catch (error) {
            console.error('Error handling offer:', error);
            alert('Unable to respond to the offer. Please try again.');
        }
    }

    async handleAnswer(answer) {
        try {
            await this.pc.setRemoteDescription(new RTCSessionDescription(answer));
            this.hasRemoteAnswer = true;
            await this.enterCallView();
        } catch (error) {
            console.error('Error handling answer:', error);
        }
    }

    async handleIceCandidate(candidate) {
        try {
            await this.pc.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (error) {
            console.error('Error handling ICE candidate:', error);
        }
    }

    toggleVideo() {
        if (this.localStream) {
            const videoTrack = this.localStream.getVideoTracks()[0];
            if (videoTrack) {
                videoTrack.enabled = !videoTrack.enabled;
                this.elements.toggleVideoBtn.classList.toggle('active');
            }
        }
    }

    toggleAudio() {
        if (this.localStream) {
            const audioTrack = this.localStream.getAudioTracks()[0];
            if (audioTrack) {
                audioTrack.enabled = !audioTrack.enabled;
                this.elements.toggleAudioBtn.classList.toggle('active');
            }
        }
    }

    sendMessage() {
        const message = this.elements.chatInput.value.trim();
        if (!message || !this.dataChannel || this.dataChannel.readyState !== 'open') return;

        this.dataChannel.send(message);
        this.displayMessage(message, true);
        this.elements.chatInput.value = '';
    }

    displayMessage(message, isLocal) {
        const messageDiv = document.createElement('div');
        messageDiv.classList.add('message', isLocal ? 'message-local' : 'message-remote');
        
        const contentDiv = document.createElement('div');
        contentDiv.classList.add('message-content');
        contentDiv.textContent = message;
        
        const timeDiv = document.createElement('div');
        timeDiv.classList.add('message-time');
        timeDiv.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        
        messageDiv.appendChild(contentDiv);
        messageDiv.appendChild(timeDiv);
        
        this.elements.chatMessages.appendChild(messageDiv);
        this.elements.chatMessages.scrollTop = this.elements.chatMessages.scrollHeight;
    }

    copyRoomCode() {
        navigator.clipboard.writeText(this.roomCode).then(() => {
            const originalText = this.elements.copyCodeBtn.textContent;
            this.elements.copyCodeBtn.textContent = 'Copied!';
            setTimeout(() => {
                this.elements.copyCodeBtn.textContent = originalText;
            }, 2000);
        });
    }

    updateConnectionStatus(status) {
        this.elements.connectionStatus.textContent = status;
        this.elements.connectionStatus.classList.toggle('connected', status === 'Connected');
    }

    handlePeerDisconnected() {
        this.updateConnectionStatus('Peer disconnected');
        this.endCall();
    }

    endCall() {
        this.stopCallTimer();
        this.toggleCallInsights(false);
        this.elements.callRole.textContent = 'Guest';
        this.stopAllPolling();
        this.hasRemoteOffer = false;
        this.hasRemoteAnswer = false;
        this.receivedIceSignatures.clear();
        this.inCallView = false;

        // Clean up media streams
        if (this.localStream) {
            this.localStream.getTracks().forEach(track => track.stop());
            this.localStream = null;
        }
        
        if (this.remoteStream) {
            this.remoteStream.getTracks().forEach(track => track.stop());
            this.remoteStream = null;
        }

        // Close peer connection
        if (this.pc) {
            this.pc.close();
            this.pc = null;
        }

        // Close data channel
        if (this.dataChannel) {
            this.dataChannel.close();
            this.dataChannel = null;
        }

        // Reset UI
        this.elements.connectionPanel.style.display = 'flex';
        this.elements.communicationPanel.style.display = 'none';
        this.elements.roomInfo.style.display = 'none';
        this.elements.roomCodeInput.value = '';
        this.elements.chatMessages.innerHTML = '';
        this.updateConnectionStatus('Disconnected');
        
        this.roomCode = null;
        this.isCreator = false;
    }

    loadRecentRooms() {
        try {
            const stored = localStorage.getItem('binarybond_recent_rooms');
            return stored ? JSON.parse(stored) : [];
        } catch (error) {
            console.warn('Unable to load recent rooms', error);
            return [];
        }
    }

    persistRecentRooms() {
        localStorage.setItem('binarybond_recent_rooms', JSON.stringify(this.recentRooms));
    }

    saveRoomToHistory(roomCode) {
        if (!roomCode) return;
        const normalized = roomCode.toUpperCase();
        const nextRooms = [normalized, ...this.recentRooms.filter(code => code !== normalized)];
        this.recentRooms = nextRooms.slice(0, 5);
        this.persistRecentRooms();
        this.renderRecentRooms();
    }

    renderRecentRooms() {
        if (!this.elements.recentRooms) return;
        const hasRooms = this.recentRooms.length > 0;
        this.elements.recentRooms.hidden = !hasRooms;
        this.elements.recentRoomList.innerHTML = '';

        if (!hasRooms) return;

        this.recentRooms.forEach(code => {
            const chip = document.createElement('button');
            chip.className = 'recent-room-chip';
            chip.type = 'button';
            chip.dataset.code = code;
            chip.textContent = code;
            this.elements.recentRoomList.appendChild(chip);
        });
    }

    handleRecentRoomClick(event) {
        const target = event.target;
        if (target.classList.contains('recent-room-chip')) {
            this.elements.roomCodeInput.value = target.dataset.code || '';
            this.elements.roomCodeInput.focus();
        }
    }

    clearRecentRooms() {
        this.recentRooms = [];
        localStorage.removeItem('binarybond_recent_rooms');
        this.renderRecentRooms();
    }

    startCallTimer() {
        this.stopCallTimer();
        this.callStartTime = Date.now();
        this.updateCallDuration();
        this.callTimer = setInterval(() => this.updateCallDuration(), 1000);
    }

    updateCallDuration() {
        if (!this.callStartTime) return;
        const elapsed = Math.floor((Date.now() - this.callStartTime) / 1000);
        const minutes = String(Math.floor(elapsed / 60)).padStart(2, '0');
        const seconds = String(elapsed % 60).padStart(2, '0');
        this.elements.callDuration.textContent = `${minutes}:${seconds}`;
    }

    stopCallTimer() {
        if (this.callTimer) {
            clearInterval(this.callTimer);
            this.callTimer = null;
        }
        this.callStartTime = null;
        if (this.elements.callDuration) {
            this.elements.callDuration.textContent = '00:00';
        }
    }

    toggleCallInsights(isActive) {
        if (!this.elements.callInsights) return;
        this.elements.callInsights.classList.toggle('active', isActive);
    }

    updateCallRole() {
        this.elements.callRole.textContent = this.isCreator ? 'Host' : 'Guest';
    }

    toggleFocusMode() {
        this.focusModeEnabled = !this.focusModeEnabled;
        document.body.classList.toggle('focus-mode', this.focusModeEnabled);
        this.elements.focusModeBtn.setAttribute('aria-pressed', String(this.focusModeEnabled));
        this.elements.focusModeBtn.textContent = this.focusModeEnabled ? 'Exit Focus' : 'Focus Mode';
    }
}

// Initialize app
document.addEventListener('DOMContentLoaded', () => {
    new BinaryBond();
});