import { useEffect, useRef, useState } from "react";
import logo from "/assets/openai-logomark.svg";
import EventLog from "./EventLog";
import SessionControls from "./SessionControls";
import ToolPanel from "./ToolPanel";
import ReactDOM from "react-dom/client";

export default function App() {
  const [isSessionActive, setIsSessionActive] = useState(false);
  const [events, setEvents] = useState([]);
  const [dataChannel, setDataChannel] = useState(null);
  const [wakeWordEnabled, setWakeWordEnabled] = useState(true);
  const [hasServerKey, setHasServerKey] = useState(false);
  const [userApiKey, setUserApiKey] = useState('');
  const [googleAuth, setGoogleAuth] = useState({ isAuthenticated: false, user: null });
  const peerConnection = useRef(null);
  const audioElement = useRef(null);

  // State for Porcupine
  const [porcupine, setPorcupine] = useState({
    keywordDetection: null,
    isLoaded: false,
    isListening: false,
    error: null,
    init: null,
    start: null,
    stop: null,
    release: null,
  });

  // Load API key from localStorage on client side
  useEffect(() => {
    const savedKey = localStorage.getItem('openai_api_key');
    if (savedKey) {
      setUserApiKey(savedKey);
    }
  }, []);

  // Load Porcupine only on the client side
  useEffect(() => {
    let mounted = true;

    const loadPorcupine = async () => {
      if (typeof window === 'undefined') return;

      try {
        const { usePorcupine } = await import('@picovoice/porcupine-react');
        if (!mounted) return;

        // Create a wrapper component to use the hook
        function PorcupineWrapper() {
          const hook = usePorcupine();
          
          useEffect(() => {
            console.log("PorcupineWrapper hook state:", {
              isLoaded: hook.isLoaded,
              isListening: hook.isListening,
              error: hook.error,
              hasInit: !!hook.init,
              hasStart: !!hook.start,
              hasStop: !!hook.stop,
            });
            
            if (mounted) setPorcupine(hook);
          }, [hook, hook.isLoaded, hook.isListening, hook.error]);
          
          return null;
        }

        // Render the wrapper component temporarily
        const div = document.createElement('div');
        const root = ReactDOM.createRoot(div);
        root.render(<PorcupineWrapper />);
        document.body.appendChild(div); // Keep the element in DOM while active

        // Cleanup
        return () => {
          mounted = false;
          root.unmount();
          div.remove();
        };
      } catch (error) {
        console.error('Failed to load Porcupine:', error);
      }
    };

    loadPorcupine();
  }, []);

  // Initialize Porcupine with the wake word
  useEffect(() => {
    if (!porcupine.init) {
      console.log("Waiting for Porcupine init function...");
      return;
    }

    const setupPorcupine = async () => {
      try {
        console.log("Starting Porcupine setup...");

        // Get Porcupine access key from server
        const response = await fetch("/porcupine/init", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
        });
        
        if (!response.ok) {
          throw new Error("Failed to get Porcupine access key");
        }
        
        const { accessKey } = await response.json();
        
        if (!accessKey) {
          throw new Error("No access key received from server");
        }

        const porcupineKeyword = {
          publicPath: "/vienta.ppn",
          label: "vienta"
        };
        const porcupineModel = {
          publicPath: "/porcupine_params.pv"
        };
        
        console.log("Initializing Porcupine with keyword and model");

        await porcupine.init(
          accessKey,
          porcupineKeyword,
          porcupineModel
        );
        
        // Auto-start wake word detection after initialization
        if (wakeWordEnabled && porcupine.start) {
          await porcupine.start();
          console.log("Auto-started wake word detection");
        }
        
        console.log("Porcupine state after init:", {
          isLoaded: porcupine.isLoaded,
          isListening: porcupine.isListening,
          error: porcupine.error,
        });
      } catch (error) {
        console.error("Failed to initialize Porcupine:", error);
      }
    };

    setupPorcupine();

    return () => {
      if (porcupine.release) {
        console.log("Releasing Porcupine resources");
        porcupine.release();
      }
    };
  }, [porcupine.init]);

  // Handle wake word detection
  useEffect(() => {
    if (porcupine.keywordDetection && wakeWordEnabled && !isSessionActive) {
      console.log("Wake word detected:", porcupine.keywordDetection.label);
      startSession();
    }
  }, [porcupine.keywordDetection, wakeWordEnabled, isSessionActive]);

  // Toggle wake word detection
  const toggleWakeWord = async () => {
    if (!porcupine.start || !porcupine.stop) {
      console.log("Porcupine start/stop functions not available:", {
        hasStart: !!porcupine.start,
        hasStop: !!porcupine.stop,
        isLoaded: porcupine.isLoaded,
      });
      return;
    }

    try {
      if (!wakeWordEnabled) {
        console.log("Starting wake word detection...");
        await porcupine.start();
        setWakeWordEnabled(true);
        console.log("Wake word detection state:", {
          isListening: porcupine.isListening,
          isLoaded: porcupine.isLoaded,
        });
      } else {
        console.log("Stopping wake word detection...");
        await porcupine.stop();
        setWakeWordEnabled(false);
        console.log("Wake word detection state:", {
          isListening: porcupine.isListening,
          isLoaded: porcupine.isLoaded,
        });
      }
    } catch (error) {
      console.error("Error toggling wake word detection:", error);
    }
  };

  // Check if server has API key configured
  useEffect(() => {
    fetch("/api-key-status")
      .then(res => res.json())
      .then(data => setHasServerKey(data.hasServerKey))
      .catch(error => console.error("Failed to check server key status:", error));
  }, []);

  // Save API key to localStorage when it changes
  useEffect(() => {
    if (userApiKey) {
      localStorage.setItem('openai_api_key', userApiKey);
    } else {
      localStorage.removeItem('openai_api_key');
    }
  }, [userApiKey]);

  // Check Google auth status
  useEffect(() => {
    fetch('/auth/status')
      .then(res => res.json())
      .then(data => setGoogleAuth(data))
      .catch(error => console.error('Failed to check Google auth status:', error));
  }, []);

  // Handle Google logout
  const handleGoogleLogout = async () => {
    try {
      const response = await fetch('/auth/logout', { method: 'POST' });
      if (response.ok) {
        setGoogleAuth({ isAuthenticated: false, user: null });
      }
    } catch (error) {
      console.error('Logout failed:', error);
    }
  };

  async function startSession() {
    // Get an ephemeral key from the Fastify server
    const headers = {
      "Content-Type": "application/json"
    };
    
    // Add user's API key if provided
    if (userApiKey) {
      headers.Authorization = `Bearer ${userApiKey}`;
    }

    const tokenResponse = await fetch("/token", { headers });
    if (!tokenResponse.ok) {
      const error = await tokenResponse.json();
      console.error("Failed to start session:", error);
      alert(error.error || "Failed to start session. Please check your API key.");
      return;
    }
    const data = await tokenResponse.json();
    const EPHEMERAL_KEY = data.client_secret.value;

    // Create a peer connection
    const pc = new RTCPeerConnection();

    // Set up to play remote audio from the model
    audioElement.current = document.createElement("audio");
    audioElement.current.autoplay = true;
    pc.ontrack = (e) => (audioElement.current.srcObject = e.streams[0]);

    // Add local audio track for microphone input in the browser
    const ms = await navigator.mediaDevices.getUserMedia({
      audio: true,
    });
    pc.addTrack(ms.getTracks()[0]);

    // Set up data channel for sending and receiving events
    const dc = pc.createDataChannel("oai-events");
    setDataChannel(dc);

    // Start the session using the Session Description Protocol (SDP)
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    const baseUrl = "https://api.openai.com/v1/realtime";
    const model = "gpt-4o-realtime-preview-2024-12-17";
    const sdpResponse = await fetch(`${baseUrl}?model=${model}`, {
      method: "POST",
      body: offer.sdp,
      headers: {
        Authorization: `Bearer ${EPHEMERAL_KEY}`,
        "Content-Type": "application/sdp",
      },
    });

    const answer = {
      type: "answer",
      sdp: await sdpResponse.text(),
    };
    await pc.setRemoteDescription(answer);

    peerConnection.current = pc;
  }

  // Stop current session, clean up peer connection and data channel
  async function stopSession() {
    // Reset the keyword detection but keep listening
    setPorcupine(prev => ({
      ...prev,
      keywordDetection: null
    }));

    if (dataChannel) {
      dataChannel.close();
    }

    peerConnection.current.getSenders().forEach((sender) => {
      if (sender.track) {
        sender.track.stop();
      }
    });

    if (peerConnection.current) {
      peerConnection.current.close();
    }

    setIsSessionActive(false);
    setDataChannel(null);
    peerConnection.current = null;
  }

  // Send a message to the model
  function sendClientEvent(message) {
    if (dataChannel) {
      message.event_id = message.event_id || crypto.randomUUID();
      dataChannel.send(JSON.stringify(message));
      setEvents((prev) => [message, ...prev]);
    } else {
      console.error(
        "Failed to send message - no data channel available",
        message,
      );
    }
  }

  // Send a text message to the model
  function sendTextMessage(message) {
    const event = {
      type: "conversation.item.create",
      item: {
        type: "message",
        role: "user",
        content: [
          {
            type: "input_text",
            text: message,
          },
        ],
      },
    };

    sendClientEvent(event);
    sendClientEvent({ type: "response.create" });
  }

  // Attach event listeners to the data channel when a new one is created
  useEffect(() => {
    if (dataChannel) {
      // Append new server events to the list
      dataChannel.addEventListener("message", (e) => {
        setEvents((prev) => [JSON.parse(e.data), ...prev]);
      });

      // Set session active when the data channel is opened
      dataChannel.addEventListener("open", () => {
        setIsSessionActive(true);
        setEvents([]);
      });
    }
  }, [dataChannel]);

  return (
    <>
      <nav className="absolute top-0 left-0 right-0 h-16 flex items-center">
        <div className="flex items-center gap-4 w-full m-4 pb-2 border-0 border-b border-solid border-gray-200">
          <img style={{ width: "24px" }} src={logo} />
          <h1>realtime console</h1>
          <div className="flex items-center gap-2 w-64 ml-auto mr-4">
            <label className="text-sm text-gray-600 whitespace-nowrap">API Key:</label>
            <input
              type="password"
              placeholder="Enter your OpenAI API key"
              value={userApiKey}
              onChange={(e) => setUserApiKey(e.target.value)}
              className="w-full px-3 py-1 border rounded text-sm"
            />
            {userApiKey && (
              <button
                onClick={() => setUserApiKey('')}
                className="px-2 py-1 text-sm text-red-600 hover:text-red-700 whitespace-nowrap"
              >
                Clear
              </button>
            )}
          </div>
          {googleAuth.isAuthenticated ? (
            <div className="flex items-center gap-2">
              <span className="text-sm text-gray-600">
                {googleAuth.user?.email}
              </span>
              <button
                onClick={handleGoogleLogout}
                className="px-4 py-2 text-sm bg-red-500 hover:bg-red-600 text-white rounded"
              >
                Disconnect Google
              </button>
            </div>
          ) : (
            <a
              href="/auth/google"
              className="px-4 py-2 text-sm bg-blue-500 hover:bg-blue-600 text-white rounded"
            >
              Connect Google
            </a>
          )}
          <button
            onClick={toggleWakeWord}
            className={`px-4 py-2 rounded ${
              wakeWordEnabled
                ? "bg-red-500 hover:bg-red-600"
                : "bg-green-500 hover:bg-green-600"
            } text-white`}
          >
            {wakeWordEnabled ? "Disable Wake Word" : "Enable Wake Word"}
          </button>
        </div>
      </nav>
      <main className="absolute top-16 left-0 right-0 bottom-0">
        <section className="absolute top-0 left-0 right-[380px] bottom-0 flex">
          <section className="absolute top-0 left-0 right-0 bottom-32 px-4 overflow-y-auto">
            <EventLog events={events} />
          </section>
          <section className="absolute h-32 left-0 right-0 bottom-0 p-4">
            <SessionControls
              startSession={startSession}
              stopSession={stopSession}
              sendClientEvent={sendClientEvent}
              sendTextMessage={sendTextMessage}
              events={events}
              isSessionActive={isSessionActive}
            />
          </section>
        </section>
        <section className="absolute top-0 w-[380px] right-0 bottom-0 p-4 pt-0 overflow-y-auto">
          <ToolPanel
            sendClientEvent={sendClientEvent}
            sendTextMessage={sendTextMessage}
            events={events}
            isSessionActive={isSessionActive}
          />
        </section>
      </main>
    </>
  );
}
