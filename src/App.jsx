import React, { useState, useEffect, useRef } from "react";
import { supabase } from "./lib/supabase";

// WebRTC Config
const ICE_SERVERS = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ]
};

export default function App() {
  const [session, setSession] = useState(null);
  const [messages, setMessages] = useState([]);
  const [inputText, setInputText] = useState("");
  const [loading, setLoading] = useState(true);
  const [authMode, setAuthMode] = useState("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [username, setUsername] = useState("");
  const [authError, setAuthError] = useState("");
  const [currentChannel, setCurrentChannel] = useState("main");
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [theme, setTheme] = useState("green");
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  
  // Voice State
  const [currentVoiceChannel, setCurrentVoiceChannel] = useState(null);
  const [isMicMuted, setIsMicMuted] = useState(false);
  const [voiceUsers, setVoiceUsers] = useState({}); // { channelId: [users] }
  
  const messagesEndRef = useRef(null);
  const peerConnections = useRef({});
  const localStream = useRef(null);
  const localSessionId = useRef(crypto.randomUUID());

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      setLoading(false);
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session);
    });

    return () => subscription.unsubscribe();
  }, []);

  useEffect(() => {
    document.body.className = `theme-${theme}`;
    const root = document.documentElement;
    if (theme === 'white') {
      root.style.setProperty('--terminal-color', '#ffffff');
      root.style.setProperty('--terminal-glow', '#ffffff');
      root.style.setProperty('--terminal-bg', '#000000');
      root.style.setProperty('--scanline', 'rgba(255, 255, 255, 0.04)');
    } else if (theme === 'red') {
      root.style.setProperty('--terminal-color', '#ff0000');
      root.style.setProperty('--terminal-glow', '#ff0000');
      root.style.setProperty('--terminal-bg', '#0a0000');
      root.style.setProperty('--scanline', 'rgba(255, 0, 0, 0.04)');
    } else {
      root.style.setProperty('--terminal-color', '#0f0');
      root.style.setProperty('--terminal-glow', '#0f0');
      root.style.setProperty('--terminal-bg', '#000500');
      root.style.setProperty('--scanline', 'rgba(0, 255, 0, 0.04)');
    }
  }, [theme]);

  // Realtime Messages
  useEffect(() => {
    if (!session) return;

    const fetchMessages = async () => {
      const { data, error } = await supabase
        .from('messages')
        .select('*')
        .eq('channel', currentChannel)
        .order('timestamp', { ascending: true })
        .limit(100);
      
      if (!error) setMessages(data || []);
    };

    fetchMessages();

    const channel = supabase
      .channel(`chat:${currentChannel}`)
      .on('postgres_changes', 
        { event: 'INSERT', table: 'messages', filter: `channel=eq.${currentChannel}` }, 
        (payload) => setMessages((prev) => [...prev, payload.new])
      )
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [session, currentChannel]);

  // Voice Channels Presence & Signaling
  useEffect(() => {
    if (!session) return;

    // Подписка на присутствие во всех голосовых каналах
    const channels = ['lobby', 'gaming', 'music'];
    const presenceUnsubs = channels.map(ch => {
      const channel = supabase.channel(`voice:${ch}`, {
        config: { presence: { key: session.user.id } }
      });

      channel
        .on('presence', { event: 'sync' }, () => {
          const state = channel.presenceState();
          const users = Object.values(state).flat();
          setVoiceUsers(prev => ({ ...prev, [ch]: users }));
        })
        .subscribe(async (status) => {
          if (status === 'SUBSCRIBED' && currentVoiceChannel === ch) {
            const userMetadata = session.user.user_metadata;
            await channel.track({
              username: userMetadata?.username || session.user.email,
              id: session.user.id,
              sessionId: localSessionId.current,
              isMicMuted
            });
          }
        });

      return channel;
    });

    // Signaling Channel
    const signalChannel = supabase.channel(`signals:${session.user.id}`)
      .on('broadcast', { event: 'signal' }, async ({ payload }) => {
        handleSignal(payload);
      })
      .subscribe();

    return () => {
      presenceUnsubs.forEach(ch => supabase.removeChannel(ch));
      supabase.removeChannel(signalChannel);
    };
  }, [session, currentVoiceChannel, isMicMuted]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const handleAuth = async (e) => {
    e.preventDefault();
    setAuthError("");
    setLoading(true);
    try {
      if (authMode === "login") {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
      } else {
        const { error } = await supabase.auth.signUp({
          email, password, options: { data: { username: username.toUpperCase() } }
        });
        if (error) throw error;
        setAuthError("Проверьте почту!");
      }
    } catch (error) { setAuthError(error.message); }
    finally { setLoading(false); }
  };

  const handleSendMessage = async (e) => {
    e.preventDefault();
    if (!inputText.trim() || !session) return;
    const userMetadata = session.user.user_metadata;
    const displayUser = userMetadata?.username || session.user.email.split('@')[0].toUpperCase();
    const { error } = await supabase.from('messages').insert([{
      content: inputText,
      username: displayUser,
      channel: currentChannel,
      timestamp: new Date().toISOString(),
      user_id: session.user.id
    }]);
    if (!error) setInputText("");
  };

  // WebRTC Logic
  const handleSignal = async (payload) => {
    const { from, signal, type } = payload;
    let pc = peerConnections.current[from];

    if (type === 'offer') {
      if (!pc) pc = createPC(from);
      await pc.setRemoteDescription(new RTCSessionDescription(signal));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      sendSignal(from, answer, 'answer');
    } else if (type === 'answer') {
      if (pc) await pc.setRemoteDescription(new RTCSessionDescription(signal));
    } else if (type === 'candidate') {
      if (pc) await pc.addIceCandidate(new RTCIceCandidate(signal));
    }
  };

  const createPC = (targetId) => {
    const pc = new RTCPeerConnection(ICE_SERVERS);
    peerConnections.current[targetId] = pc;

    if (localStream.current) {
      localStream.current.getTracks().forEach(track => pc.addTrack(track, localStream.current));
    }

    pc.onicecandidate = (event) => {
      if (event.candidate) sendSignal(targetId, event.candidate, 'candidate');
    };

    pc.ontrack = (event) => {
      const remoteStream = event.streams[0];
      const audio = new Audio();
      audio.srcObject = remoteStream;
      audio.play();
    };

    return pc;
  };

  const sendSignal = (to, signal, type) => {
    supabase.channel(`signals:${to}`).send({
      type: 'broadcast',
      event: 'signal',
      payload: { from: session.user.id, signal, type }
    });
  };

  const joinVoice = async (ch) => {
    if (currentVoiceChannel === ch) {
      leaveVoice();
      return;
    }
    
    try {
      localStream.current = await navigator.mediaDevices.getUserMedia({ audio: true });
      setCurrentVoiceChannel(ch);
      // При изменении currentVoiceChannel сработает useEffect с presence
    } catch (err) {
      console.error("Mic access error:", err);
    }
  };

  const leaveVoice = () => {
    if (localStream.current) {
      localStream.current.getTracks().forEach(t => t.stop());
      localStream.current = null;
    }
    Object.values(peerConnections.current).forEach(pc => pc.close());
    peerConnections.current = {};
    setCurrentVoiceChannel(null);
  };

  // Voice Messages State
  const [isRecording, setIsRecording] = useState(false);
  const [recordingTime, setRecordingTime] = useState(0);
  const mediaRecorder = useRef(null);
  const audioChunks = useRef([]);
  const recordingTimer = useRef(null);

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaRecorder.current = new MediaRecorder(stream);
      audioChunks.current = [];
      
      mediaRecorder.current.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunks.current.push(e.data);
      };

      mediaRecorder.current.onstop = async () => {
        const audioBlob = new Blob(audioChunks.current, { type: 'audio/webm' });
        await sendVoiceMessage(audioBlob);
        stream.getTracks().forEach(t => t.stop());
      };

      mediaRecorder.current.start();
      setIsRecording(true);
      setRecordingTime(0);
      recordingTimer.current = setInterval(() => {
        setRecordingTime(prev => prev + 1);
      }, 1000);
    } catch (err) {
      console.error("Recording error:", err);
    }
  };

  const stopRecording = () => {
    if (mediaRecorder.current && isRecording) {
      mediaRecorder.current.stop();
      setIsRecording(false);
      clearInterval(recordingTimer.current);
    }
  };

  const sendVoiceMessage = async (blob) => {
    const reader = new FileReader();
    reader.readAsDataURL(blob);
    reader.onloadend = async () => {
      const base64data = reader.result;
      const userMetadata = session.user.user_metadata;
      const displayUser = userMetadata?.username || session.user.email.split('@')[0].toUpperCase();
      
      await supabase.from('messages').insert([{
        content: "[VOICE_MESSAGE]",
        username: displayUser,
        channel: currentChannel,
        type: 'voice',
        voice_url: base64data,
        duration: recordingTime,
        timestamp: new Date().toISOString(),
        user_id: session.user.id
      }]);
    };
  };

  const toggleSidebar = () => setIsSidebarOpen(!isSidebarOpen);

  if (loading && !session) {
    return (
      <div className="h-screen w-screen bg-black flex items-center justify-center text-green-500 font-mono">
        <div className="animate-pulse">>> INITIALIZING_SLAX_OS...</div>
      </div>
    );
  }

  if (!session) {
    return (
      <div className="h-screen w-screen flex flex-col items-center justify-center bg-black font-mono text-green-500 overflow-hidden relative">
        <div className="scanlines"></div>
        <div className="crt-flicker absolute inset-0 pointer-events-none"></div>

        <pre className="text-xs sm:text-base leading-none mb-8 text-center font-bold">
{` ____  _        _    __  __
/ ___|| |      / \\   \\ \\/ /
\\___ \\| |     / _ \\   \\  /
 ___) | |___ / ___ \\  /  \\
|____/|_____/_/   \\_\\/_/\\_\\
     OPERATING SYSTEM v5.0`}
        </pre>

        <div className="w-11/12 max-w-md p-6 border-2 border-green-800 bg-black/90 shadow-[0_0_20px_rgba(0,255,0,0.2)] z-10">
          <p className="mb-2 text-green-400 font-bold text-center text-base sm:text-lg">
            >> {authMode === "login" ? "LOG IN REQUIRED" : "REGISTER NEW USER"}
          </p>
          <div className="h-px w-full bg-green-900 mb-4"></div>

          <form onSubmit={handleAuth} className="space-y-4">
            {authMode === "register" && (
              <div className="flex items-center text-sm sm:text-base">
                <span className="mr-3 whitespace-nowrap">USER:</span>
                <input
                  type="text"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  className="flex-1 border-b border-green-800 focus:border-green-500 bg-transparent outline-none"
                  placeholder="enter_callsign"
                  required
                />
              </div>
            )}
            <div className="flex items-center text-sm sm:text-base">
              <span className="mr-3 whitespace-nowrap">MAIL:</span>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="flex-1 border-b border-green-800 focus:border-green-500 bg-transparent outline-none"
                placeholder="enter_email"
                required
              />
            </div>
            <div className="flex items-center text-sm sm:text-base">
              <span className="mr-3 whitespace-nowrap">PASS:</span>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="flex-1 border-b border-green-800 focus:border-green-500 bg-transparent outline-none"
                placeholder="enter_password"
                required
              />
            </div>

            {authError && <p className="text-red-500 text-xs text-center">>> {authError}</p>}

            <button
              type="submit"
              className="mt-6 border border-green-600 px-4 py-2 hover:bg-green-600 hover:text-black transition-all w-full text-center font-bold tracking-widest text-sm sm:text-base"
            >
              [ {authMode === "login" ? "CONNECT" : "CREATE USER"} ]
            </button>
          </form>

          <button
            onClick={() => setAuthMode(authMode === "login" ? "register" : "login")}
            className="mt-3 text-xs opacity-70 hover:opacity-100 transition-opacity w-full text-center"
          >
            [ SWITCH TO {authMode === "login" ? "REGISTER" : "LOG IN"} ]
          </button>
        </div>
      </div>
    );
  }

  const currentUserDisplay = session.user.user_metadata?.username || session.user.email.split('@')[0].toUpperCase();

  return (
    <div className="h-screen w-screen flex font-mono text-green-500 bg-black overflow-hidden relative">
      <div className="scanlines"></div>
      <div className="crt-flicker absolute inset-0 pointer-events-none"></div>

      {isSidebarOpen && <div onClick={toggleSidebar} className="md:hidden absolute inset-0 bg-black/50 z-20" />}

      <aside className={`fixed md:relative w-64 md:w-72 h-full z-30 border-r-2 border-green-900 flex flex-col bg-black/95 transition-transform duration-300 ${isSidebarOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0'}`}>
        <div className="p-3 border-b-2 border-green-900 bg-[#051105]">
          <div className="font-bold text-lg sm:text-xl tracking-wider">SLAX_OS</div>
          <div className="text-xs opacity-70 flex justify-between mt-1">
            <span>NET: ONLINE</span>
            <span>SID: {session.user.id.slice(0, 8).toUpperCase()}</span>
          </div>
        </div>

        <div className="p-4 flex-1 overflow-y-auto text-sm">
          <div className="mb-6">
            <h3 className="text-xs font-bold opacity-60 mb-3 tracking-widest border-b border-green-900/50 pb-1">TEXT_PROTOCOLS</h3>
            <ul className="space-y-1">
              {['main', 'offtopic', 'dev'].map(ch => (
                <li 
                  key={ch}
                  onClick={() => { setCurrentChannel(ch); setIsSidebarOpen(false); }}
                  className={`cursor-pointer p-2 hover:bg-green-900/20 transition-all ${currentChannel === ch ? 'channel-active' : ''}`}
                >
                  # {ch.toUpperCase()}
                </li>
              ))}
            </ul>
          </div>

          <div className="mb-6">
            <h3 className="text-xs font-bold opacity-60 mb-3 tracking-widest border-b border-green-900/50 pb-1">VOICE_UPLINKS</h3>
            <ul className="space-y-2">
              {['lobby', 'gaming', 'music'].map(ch => (
                <li 
                  key={ch}
                  onClick={() => joinVoice(ch)}
                  className={`cursor-pointer border border-green-900/50 p-2 hover:border-green-500 transition-all group ${currentVoiceChannel === ch ? 'border-green-500 bg-green-900/20' : ''}`}
                >
                  <div className="flex justify-between items-center">
                    <span>{ch.toUpperCase()}</span>
                    <span className="text-[10px] bg-green-900 px-1 text-black">{voiceUsers[ch]?.length || 0}</span>
                  </div>
                  <div className="mt-1 pl-2 text-[10px] opacity-80 border-l border-green-800 ml-1">
                    {voiceUsers[ch]?.map(u => (
                      <div key={u.id} className="truncate">>> {u.username} {u.isMicMuted ? '🔇' : ''}</div>
                    ))}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </div>

        <div className="p-3 border-t-2 border-green-900 bg-black">
          <div className="flex items-center justify-between">
            <div className="flex items-center">
              <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse mr-2"></div>
              <div className="font-bold tracking-wider truncate max-w-[120px]">{currentUserDisplay}</div>
            </div>
            <button onClick={() => supabase.auth.signOut()} className="text-[10px] border border-red-900 px-1 hover:bg-red-900 transition-colors">LOGOUT</button>
          </div>
          <button 
            onClick={() => setIsSettingsOpen(true)}
            className="w-full mt-2 border border-green-900 py-1 text-[10px] hover:bg-green-900/30 transition-all"
          >
            [ SYSTEM_SETTINGS ]
          </button>
        </div>
      </aside>

      <main className="flex-1 flex flex-col relative bg-black min-w-0">
        {isSettingsOpen && (
          <div className="absolute inset-0 z-50 bg-black/95 flex items-center justify-center p-4">
            <div className="w-full max-w-md border-2 border-green-500 bg-black p-6 shadow-[0_0_30px_rgba(0,255,0,0.2)]">
              <div className="flex justify-between items-center mb-6">
                <h2 className="text-xl font-bold tracking-widest text-green-400">>> SYSTEM_SETTINGS</h2>
                <button onClick={() => setIsSettingsOpen(false)} className="text-green-500 hover:text-white">[ X ]</button>
              </div>
              
              <div className="space-y-6">
                <div>
                  <label className="block text-xs opacity-60 mb-2 tracking-widest">VISUAL_THEME</label>
                  <div className="grid grid-cols-3 gap-2">
                    {['green', 'white', 'red'].map(t => (
                      <button 
                        key={t}
                        onClick={() => setTheme(t)}
                        className={`py-2 border text-xs transition-all ${theme === t ? 'bg-green-600 text-black border-green-400' : 'border-green-900 hover:border-green-500'}`}
                      >
                        {t.toUpperCase()}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="pt-4 border-t border-green-900">
                  <p className="text-[10px] opacity-40 mb-4">SLAX_OS CORE_V5.0.42_STABLE</p>
                  <button 
                    onClick={() => setIsSettingsOpen(false)}
                    className="w-full py-2 bg-green-900/20 border border-green-500 text-green-500 hover:bg-green-600 hover:text-black transition-all font-bold"
                  >
                    APPLY_CHANGES
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
        <header className="h-14 border-b border-green-900 flex items-center px-4 md:px-6 justify-between bg-[#050905]">
          <button onClick={toggleSidebar} className="md:hidden text-green-400 text-lg mr-4">[ MENU ]</button>
          <span className="text-lg sm:text-xl font-bold tracking-widest truncate">>> #{currentChannel.toUpperCase()}</span>
          <div className="flex items-center space-x-4 text-xs">
            <span className="hidden md:inline slax-loader opacity-50"></span>
            <span className="border border-green-700 px-2 py-0.5">REC ●</span>
          </div>
        </header>

        <div className="flex-1 overflow-y-auto p-4 md:p-6 space-y-2">
          {messages.map((msg, i) => (
            <div key={msg.id || i} className="group flex flex-col sm:flex-row sm:items-baseline space-y-1 sm:space-y-0 sm:space-x-2 border-l-2 border-green-800 pl-2 py-1">
              <div className="flex items-baseline space-x-2">
                <span className="text-[10px] text-green-900 font-mono">[{new Date(msg.timestamp).toLocaleTimeString()}]</span>
                <span className="font-bold text-green-400 text-sm">{msg.username}:</span>
              </div>
              {msg.type === 'voice' ? (
                <div className="flex items-center space-x-3 bg-green-900/10 p-2 border border-green-900/50 rounded-sm">
                  <button 
                    onClick={() => {
                      const audio = new Audio(msg.voice_url);
                      audio.play();
                    }}
                    className="text-xs border border-green-700 px-2 py-1 hover:bg-green-700 hover:text-black transition-all"
                  >
                    PLAY_VOICE
                  </button>
                  <span className="text-[10px] opacity-60">{msg.duration}s</span>
                  <div className="flex-1 h-1 bg-green-900/30 w-24 relative overflow-hidden">
                    <div className="absolute inset-0 bg-green-500/20 animate-pulse"></div>
                  </div>
                </div>
              ) : (
                <span className="text-sm break-words text-green-100">{msg.content}</span>
              )}
            </div>
          ))}
          <div ref={messagesEndRef} />
        </div>

        <footer className="p-3 sm:p-4 bg-black border-t border-green-900">
          {isRecording && (
            <div className="mb-2 flex items-center justify-between bg-red-900/20 border border-red-800 p-2 text-xs">
              <div className="flex items-center">
                <span className="w-2 h-2 bg-red-500 rounded-full animate-ping mr-2"></span>
                <span className="text-red-500 font-bold">RECORDING: {recordingTime}s</span>
              </div>
              <button onClick={stopRecording} className="text-red-500 border border-red-800 px-2 py-1 hover:bg-red-800 hover:text-white">
                STOP & SEND
              </button>
            </div>
          )}
          {currentVoiceChannel && (
            <div className="mb-2 flex items-center justify-between bg-green-900/20 border border-green-800 p-2 text-xs">
              <div className="flex items-center">
                <span className="w-2 h-2 bg-red-500 rounded-full animate-ping mr-2"></span>
                <span>VOICE: {currentVoiceChannel.toUpperCase()}</span>
              </div>
              <div className="flex space-x-2">
                <button onClick={() => setIsMicMuted(!isMicMuted)} className="border border-green-700 px-2 py-1 hover:bg-green-700">
                  {isMicMuted ? 'UNMUTE' : 'MUTE'}
                </button>
                <button onClick={leaveVoice} className="border border-red-900 px-2 py-1 hover:bg-red-900 text-red-500 hover:text-white">
                  DISCONNECT
                </button>
              </div>
            </div>
          )}
          <form onSubmit={handleSendMessage} className="flex items-center bg-green-900/10 border border-green-800 p-2 focus-within:border-green-500 transition-colors">
            <span className="mr-3 text-green-500 font-bold whitespace-nowrap text-sm sm:text-base">root@slax:~#</span>
            <input 
              type="text" 
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              placeholder="execute_command..."
              className="flex-1 bg-transparent border-none outline-none text-green-500 text-sm sm:text-base placeholder-green-900"
              autoFocus
            />
            <button 
              type="button"
              onMouseDown={startRecording}
              onMouseUp={stopRecording}
              onTouchStart={startRecording}
              onTouchEnd={stopRecording}
              className={`ml-2 p-2 border transition-all ${isRecording ? 'bg-red-900 border-red-500 text-white' : 'border-green-800 text-green-800 hover:border-green-500 hover:text-green-500'}`}
              title="Удерживайте для записи голоса"
            >
              🎤
            </button>
          </form>
        </footer>
      </main>
    </div>
  );
}
