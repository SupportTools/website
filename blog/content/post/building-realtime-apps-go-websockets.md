---
title: "Building Real-Time Applications in Go with WebSockets: A Complete Guide"
date: 2025-10-28T09:00:00-05:00
draft: false
tags: ["go", "golang", "websockets", "real-time", "gorilla", "concurrency"]
categories: ["Programming", "Go", "Web Development"]
---

In today's web landscape, users expect immediate responses and real-time updates. From collaborative editors and live dashboards to chat applications and multiplayer games, real-time functionality has become a standard feature. WebSockets enable this by providing full-duplex communication between clients and servers over a persistent connection.

Go's concurrency model, with lightweight goroutines and channels, makes it an excellent choice for building scalable WebSocket servers that can handle thousands of concurrent connections efficiently. This guide explores how to leverage Go and WebSockets to build robust real-time applications.

## Understanding WebSockets

WebSockets represent a significant evolution from the traditional HTTP request-response model. Unlike HTTP:

- WebSockets maintain a persistent connection after the initial handshake
- Communication is bidirectional, allowing both client and server to send messages independently
- Messages can be sent with minimal overhead, reducing latency
- The protocol supports both text and binary data

This makes WebSockets ideal for applications where timely delivery of small messages is crucial.

## Why Go Excels for WebSocket Applications

Go offers several advantages that make it particularly well-suited for WebSocket implementations:

1. **Lightweight Concurrency**: Goroutines consume only a few KB of memory, allowing your server to handle thousands of concurrent WebSocket connections efficiently.

2. **Built for Networking**: Go's standard library provides robust networking primitives, and its concurrency model was designed with networked services in mind.

3. **Simplicity**: Go's straightforward syntax and minimal abstraction make WebSocket implementations clean and maintainable.

4. **Performance**: Go's compiled nature and efficient garbage collection provide excellent performance for real-time applications.

5. **Rich Ecosystem**: Packages like Gorilla WebSocket provide production-ready WebSocket implementations that build on Go's strengths.

## Getting Started: A Simple WebSocket Echo Server

Let's begin with a basic WebSocket echo server that upgrades HTTP connections to WebSockets and echoes any messages it receives back to the client.

First, create a new Go module:

```bash
mkdir websocket-demo
cd websocket-demo
go mod init github.com/yourusername/websocket-demo
```

Next, install the Gorilla WebSocket package:

```bash
go get github.com/gorilla/websocket
```

Now, create a `main.go` file with the following code:

```go
package main

import (
	"fmt"
	"log"
	"net/http"

	"github.com/gorilla/websocket"
)

// Configure the upgrader
var upgrader = websocket.Upgrader{
	ReadBufferSize:  1024,
	WriteBufferSize: 1024,
	// Allow all origins for now
	CheckOrigin: func(r *http.Request) bool {
		return true
	},
}

// Define our WebSocket handler
func handleWebSocket(w http.ResponseWriter, r *http.Request) {
	// Upgrade initial HTTP connection to WebSocket
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("Error upgrading connection: %v", err)
		return
	}
	defer conn.Close()

	log.Printf("Client connected: %s", conn.RemoteAddr())

	// Listen for messages
	for {
		messageType, message, err := conn.ReadMessage()
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseAbnormalClosure) {
				log.Printf("Error reading message: %v", err)
			}
			break // Break out of the loop to close the connection
		}

		log.Printf("Received message: %s", message)

		// Echo the message back to the client
		if err := conn.WriteMessage(messageType, message); err != nil {
			log.Printf("Error writing message: %v", err)
			break
		}
	}

	log.Printf("Client disconnected: %s", conn.RemoteAddr())
}

func main() {
	// Serve a simple HTML page for testing
	http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		http.ServeFile(w, r, "index.html")
	})

	// WebSocket endpoint
	http.HandleFunc("/ws", handleWebSocket)

	// Start the server
	port := "8080"
	log.Printf("Server starting on :%s", port)
	if err := http.ListenAndServe(":"+port, nil); err != nil {
		log.Fatal("ListenAndServe error:", err)
	}
}
```

Now, create an `index.html` file for testing:

```html
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>WebSocket Demo</title>
    <style>
        body {
            font-family: Arial, sans-serif;
            max-width: 800px;
            margin: 0 auto;
            padding: 20px;
        }
        #messages {
            border: 1px solid #ccc;
            height: 300px;
            margin-bottom: 20px;
            overflow-y: auto;
            padding: 10px;
        }
        #message-form {
            display: flex;
        }
        #message-input {
            flex-grow: 1;
            margin-right: 10px;
            padding: 8px;
        }
        .status {
            color: #666;
            font-style: italic;
        }
        .error {
            color: red;
        }
        .message {
            margin: 5px 0;
        }
    </style>
</head>
<body>
    <h1>WebSocket Echo Test</h1>
    <div id="connection-status">Status: Disconnected</div>
    <div id="messages"></div>
    <form id="message-form">
        <input type="text" id="message-input" placeholder="Type a message and press Enter" />
        <button type="submit">Send</button>
    </form>

    <script>
        const messagesDiv = document.getElementById('messages');
        const messageForm = document.getElementById('message-form');
        const messageInput = document.getElementById('message-input');
        const connectionStatus = document.getElementById('connection-status');
        
        let socket = null;

        function connectWebSocket() {
            // Create WebSocket connection
            socket = new WebSocket(`ws://${window.location.host}/ws`);
            
            // Connection opened
            socket.addEventListener('open', (event) => {
                addMessage('Connected to server', 'status');
                connectionStatus.textContent = 'Status: Connected';
                messageInput.disabled = false;
            });
            
            // Listen for messages
            socket.addEventListener('message', (event) => {
                addMessage(`Server: ${event.data}`);
            });
            
            // Connection closed
            socket.addEventListener('close', (event) => {
                addMessage('Disconnected from server', 'status');
                connectionStatus.textContent = 'Status: Disconnected';
                messageInput.disabled = true;
                
                // Try to reconnect after a delay
                setTimeout(connectWebSocket, 3000);
            });
            
            // Connection error
            socket.addEventListener('error', (event) => {
                addMessage('WebSocket error', 'error');
                console.error('WebSocket error:', event);
            });
        }
        
        function addMessage(message, className = 'message') {
            const messageElement = document.createElement('div');
            messageElement.classList.add(className);
            messageElement.textContent = message;
            messagesDiv.appendChild(messageElement);
            messagesDiv.scrollTop = messagesDiv.scrollHeight;
        }
        
        // Handle form submission
        messageForm.addEventListener('submit', (e) => {
            e.preventDefault();
            const message = messageInput.value.trim();
            if (message && socket && socket.readyState === WebSocket.OPEN) {
                socket.send(message);
                addMessage(`You: ${message}`);
                messageInput.value = '';
            }
        });
        
        // Start with input disabled
        messageInput.disabled = true;
        
        // Connect on page load
        connectWebSocket();
    </script>
</body>
</html>
```

Run the server:

```bash
go run main.go
```

Open your browser to `http://localhost:8080` to test the WebSocket connection. You should see messages echo back from the server when you send them.

## Building a Real-Time Chat Application

Now let's create a more practical example: a real-time chat application. We'll build a server that broadcasts messages to all connected clients.

Update the `main.go` file:

```go
package main

import (
	"log"
	"net/http"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// Configure the upgrader
var upgrader = websocket.Upgrader{
	ReadBufferSize:  1024,
	WriteBufferSize: 1024,
	CheckOrigin: func(r *http.Request) bool {
		return true
	},
}

// Client represents a connected WebSocket client
type Client struct {
	conn     *websocket.Conn
	send     chan []byte
	username string
}

// ChatMessage represents a chat message with metadata
type ChatMessage struct {
	Type     string `json:"type"`
	Username string `json:"username,omitempty"`
	Message  string `json:"message,omitempty"`
	Time     string `json:"time,omitempty"`
}

// Hub maintains the set of active clients and broadcasts messages
type Hub struct {
	clients    map[*Client]bool
	broadcast  chan []byte
	register   chan *Client
	unregister chan *Client
	mutex      sync.Mutex
}

func newHub() *Hub {
	return &Hub{
		clients:    make(map[*Client]bool),
		broadcast:  make(chan []byte, 256),
		register:   make(chan *Client),
		unregister: make(chan *Client),
	}
}

func (h *Hub) run() {
	for {
		select {
		case client := <-h.register:
			h.mutex.Lock()
			h.clients[client] = true
			h.mutex.Unlock()
		case client := <-h.unregister:
			h.mutex.Lock()
			if _, ok := h.clients[client]; ok {
				delete(h.clients, client)
				close(client.send)
			}
			h.mutex.Unlock()
		case message := <-h.broadcast:
			h.mutex.Lock()
			for client := range h.clients {
				select {
				case client.send <- message:
				default:
					close(client.send)
					delete(h.clients, client)
				}
			}
			h.mutex.Unlock()
		}
	}
}

// writePump pumps messages from the hub to the websocket connection
func (c *Client) writePump() {
	ticker := time.NewTicker(60 * time.Second)
	defer func() {
		ticker.Stop()
		c.conn.Close()
	}()

	for {
		select {
		case message, ok := <-c.send:
			if !ok {
				// The hub closed the channel
				c.conn.WriteMessage(websocket.CloseMessage, []byte{})
				return
			}

			w, err := c.conn.NextWriter(websocket.TextMessage)
			if err != nil {
				return
			}
			w.Write(message)

			// Add any queued messages
			n := len(c.send)
			for i := 0; i < n; i++ {
				w.Write([]byte{'\n'})
				w.Write(<-c.send)
			}

			if err := w.Close(); err != nil {
				return
			}
		case <-ticker.C:
			// Send a ping message
			if err := c.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}

// readPump pumps messages from the websocket connection to the hub
func (c *Client) readPump(hub *Hub) {
	defer func() {
		hub.unregister <- c
		c.conn.Close()
	}()

	c.conn.SetReadLimit(512) // Max message size
	c.conn.SetReadDeadline(time.Now().Add(60 * time.Second))
	c.conn.SetPongHandler(func(string) error {
		c.conn.SetReadDeadline(time.Now().Add(60 * time.Second))
		return nil
	})

	// Read username from the first message
	_, message, err := c.conn.ReadMessage()
	if err != nil {
		log.Println("Error reading username:", err)
		return
	}
	c.username = string(message)
	
	// Prepare a user joined message
	joinMsg := ChatMessage{
		Type:     "system",
		Message:  c.username + " has joined the chat",
		Time:     time.Now().Format("15:04:05"),
	}
	joinMsgJSON, _ := json.Marshal(joinMsg)
	hub.broadcast <- joinMsgJSON

	for {
		_, message, err := c.conn.ReadMessage()
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseAbnormalClosure) {
				log.Printf("Error reading message: %v", err)
			}
			break
		}

		// Create a chat message
		chatMsg := ChatMessage{
			Type:     "message",
			Username: c.username,
			Message:  string(message),
			Time:     time.Now().Format("15:04:05"),
		}
		msgJSON, _ := json.Marshal(chatMsg)
		hub.broadcast <- msgJSON
	}

	// Prepare a user left message
	leaveMsg := ChatMessage{
		Type:     "system",
		Message:  c.username + " has left the chat",
		Time:     time.Now().Format("15:04:05"),
	}
	leaveMsgJSON, _ := json.Marshal(leaveMsg)
	hub.broadcast <- leaveMsgJSON
}

func serveWs(hub *Hub, w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Println("Error upgrading connection:", err)
		return
	}

	client := &Client{
		conn:     conn,
		send:     make(chan []byte, 256),
		username: "",
	}
	hub.register <- client

	// Run the pumps in separate goroutines
	go client.writePump()
	go client.readPump(hub)
}

func main() {
	hub := newHub()
	go hub.run()

	// Serve static files
	http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		http.ServeFile(w, r, "chat.html")
	})

	// WebSocket endpoint
	http.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		serveWs(hub, w, r)
	})

	// Start the server
	port := "8080"
	log.Printf("Server starting on :%s", port)
	log.Fatal(http.ListenAndServe(":"+port, nil))
}
```

Now, create a `chat.html` file for the chat interface:

```html
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Go WebSocket Chat</title>
    <style>
        body {
            font-family: Arial, sans-serif;
            margin: 0;
            padding: 0;
            height: 100vh;
            display: flex;
            flex-direction: column;
        }
        .container {
            max-width: 800px;
            margin: 0 auto;
            padding: 20px;
            flex-grow: 1;
            display: flex;
            flex-direction: column;
            width: 100%;
        }
        .header {
            padding: 10px 0;
            border-bottom: 1px solid #ccc;
            margin-bottom: 15px;
        }
        #chat-window {
            flex-grow: 1;
            overflow-y: auto;
            border: 1px solid #ccc;
            padding: 10px;
            margin-bottom: 15px;
            border-radius: 4px;
            background-color: #f9f9f9;
        }
        #message-form {
            display: flex;
            margin-bottom: 15px;
        }
        #message-input {
            flex-grow: 1;
            padding: 10px;
            border: 1px solid #ccc;
            border-radius: 4px;
            margin-right: 10px;
        }
        button {
            padding: 10px 15px;
            background-color: #4CAF50;
            color: white;
            border: none;
            border-radius: 4px;
            cursor: pointer;
        }
        button:hover {
            background-color: #45a049;
        }
        .message {
            margin-bottom: 10px;
            padding: 8px 12px;
            border-radius: 4px;
            max-width: 70%;
        }
        .message .time {
            font-size: 0.8em;
            color: #666;
            margin-left: 5px;
        }
        .message .username {
            font-weight: bold;
            margin-right: 5px;
        }
        .system-message {
            color: #666;
            font-style: italic;
            text-align: center;
            margin: 10px 0;
        }
        .user-container {
            text-align: center;
            padding: 20px;
        }
        #username-form {
            display: inline-block;
        }
        #username-input {
            padding: 10px;
            border: 1px solid #ccc;
            border-radius: 4px;
            margin-right: 10px;
            width: 200px;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>Go WebSocket Chat</h1>
        </div>
        
        <!-- Username form (shown first) -->
        <div id="user-container" class="user-container">
            <h2>Enter your username to join the chat</h2>
            <form id="username-form">
                <input type="text" id="username-input" placeholder="Username" required>
                <button type="submit">Join Chat</button>
            </form>
        </div>
        
        <!-- Chat interface (hidden until username is entered) -->
        <div id="chat-interface" style="display: none; flex-grow: 1; display: flex; flex-direction: column;">
            <div id="chat-window"></div>
            <form id="message-form">
                <input type="text" id="message-input" placeholder="Type a message..." autocomplete="off" required>
                <button type="submit">Send</button>
            </form>
        </div>
    </div>
    
    <script>
        const userContainer = document.getElementById('user-container');
        const chatInterface = document.getElementById('chat-interface');
        const usernameForm = document.getElementById('username-form');
        const usernameInput = document.getElementById('username-input');
        const chatWindow = document.getElementById('chat-window');
        const messageForm = document.getElementById('message-form');
        const messageInput = document.getElementById('message-input');
        
        let socket = null;
        let username = '';
        
        // Handle username submission
        usernameForm.addEventListener('submit', (e) => {
            e.preventDefault();
            username = usernameInput.value.trim();
            if (username) {
                // Hide username form and show chat interface
                userContainer.style.display = 'none';
                chatInterface.style.display = 'flex';
                
                // Connect to WebSocket
                connectWebSocket();
            }
        });
        
        function connectWebSocket() {
            // Create WebSocket connection
            socket = new WebSocket(`ws://${window.location.host}/ws`);
            
            // Connection opened
            socket.addEventListener('open', (event) => {
                // Send username as the first message
                socket.send(username);
            });
            
            // Listen for messages
            socket.addEventListener('message', (event) => {
                try {
                    const message = JSON.parse(event.data);
                    displayMessage(message);
                } catch (error) {
                    console.error('Error parsing message:', error);
                }
            });
            
            // Connection closed
            socket.addEventListener('close', (event) => {
                addSystemMessage('Disconnected from server. Trying to reconnect...');
                setTimeout(connectWebSocket, 3000);
            });
            
            // Connection error
            socket.addEventListener('error', (event) => {
                console.error('WebSocket error:', event);
            });
        }
        
        function displayMessage(message) {
            if (message.type === 'system') {
                addSystemMessage(message.message);
            } else {
                // Regular chat message
                const isOwnMessage = message.username === username;
                
                const messageDiv = document.createElement('div');
                messageDiv.className = `message ${isOwnMessage ? 'own-message' : 'other-message'}`;
                messageDiv.style.backgroundColor = isOwnMessage ? '#dcf8c6' : '#f2f2f2';
                messageDiv.style.alignSelf = isOwnMessage ? 'flex-end' : 'flex-start';
                
                const usernameSpan = document.createElement('span');
                usernameSpan.className = 'username';
                usernameSpan.textContent = message.username;
                usernameSpan.style.color = isOwnMessage ? '#009688' : '#2196F3';
                
                const contentSpan = document.createElement('span');
                contentSpan.className = 'content';
                contentSpan.textContent = message.message;
                
                const timeSpan = document.createElement('span');
                timeSpan.className = 'time';
                timeSpan.textContent = message.time;
                
                messageDiv.appendChild(usernameSpan);
                messageDiv.appendChild(contentSpan);
                messageDiv.appendChild(timeSpan);
                
                chatWindow.appendChild(messageDiv);
            }
            
            // Scroll to bottom
            chatWindow.scrollTop = chatWindow.scrollHeight;
        }
        
        function addSystemMessage(text) {
            const systemDiv = document.createElement('div');
            systemDiv.className = 'system-message';
            systemDiv.textContent = text;
            chatWindow.appendChild(systemDiv);
            chatWindow.scrollTop = chatWindow.scrollHeight;
        }
        
        // Handle message submission
        messageForm.addEventListener('submit', (e) => {
            e.preventDefault();
            const message = messageInput.value.trim();
            if (message && socket && socket.readyState === WebSocket.OPEN) {
                socket.send(message);
                messageInput.value = '';
            }
        });
    </script>
</body>
</html>
```

Run the server:

```bash
go run main.go
```

Open multiple browser tabs to `http://localhost:8080` to test the chat functionality. Each client will need to enter a username to join the chat.

## Implementing Advanced Features

Now let's enhance our chat application with some advanced features:

1. User presence (typing indicators)
2. Read receipts
3. Message history

Here's an updated version of our main.go file:

```go
package main

import (
	"encoding/json"
	"log"
	"net/http"
	"sync"
	"time"

	"github.com/gorilla/websocket"
)

// Configure the upgrader
var upgrader = websocket.Upgrader{
	ReadBufferSize:  1024,
	WriteBufferSize: 1024,
	CheckOrigin: func(r *http.Request) bool {
		return true
	},
}

// Client represents a connected WebSocket client
type Client struct {
	conn     *websocket.Conn
	send     chan []byte
	username string
	isTyping bool
}

// MessageType defines the types of messages exchanged
type MessageType string

const (
	TextMessage  MessageType = "message"
	SystemMessage MessageType = "system"
	TypingMessage MessageType = "typing"
	PresenceMessage MessageType = "presence"
	HistoryMessage MessageType = "history"
)

// ChatMessage represents a chat message with metadata
type ChatMessage struct {
	ID       string      `json:"id,omitempty"`
	Type     MessageType `json:"type"`
	Username string      `json:"username,omitempty"`
	Message  string      `json:"message,omitempty"`
	Time     string      `json:"time,omitempty"`
	IsTyping bool        `json:"isTyping,omitempty"`
	Users    []string    `json:"users,omitempty"`
}

// Hub maintains the set of active clients and broadcasts messages
type Hub struct {
	clients    map[*Client]bool
	broadcast  chan []byte
	register   chan *Client
	unregister chan *Client
	mutex      sync.Mutex
	history    []ChatMessage // Store recent messages
}

func newHub() *Hub {
	return &Hub{
		clients:    make(map[*Client]bool),
		broadcast:  make(chan []byte, 256),
		register:   make(chan *Client),
		unregister: make(chan *Client),
		history:    make([]ChatMessage, 0, 50), // Keep last 50 messages
	}
}

func (h *Hub) run() {
	for {
		select {
		case client := <-h.register:
			h.mutex.Lock()
			// Track the new client
			h.clients[client] = true
			
			// Get active users list
			userList := make([]string, 0, len(h.clients))
			for c := range h.clients {
				if c.username != "" {
					userList = append(userList, c.username)
				}
			}
			
			// Send presence update to all clients
			presenceMsg := ChatMessage{
				Type:  PresenceMessage,
				Users: userList,
				Time:  time.Now().Format("15:04:05"),
			}
			presenceMsgJSON, _ := json.Marshal(presenceMsg)
			
			for c := range h.clients {
				select {
				case c.send <- presenceMsgJSON:
				default:
					close(c.send)
					delete(h.clients, c)
				}
			}
			
			// Send history to the new client
			if len(h.history) > 0 {
				historyMsg := ChatMessage{
					Type:    HistoryMessage,
					Time:    time.Now().Format("15:04:05"),
				}
				// Copy the history messages
				historyMsg.History = make([]ChatMessage, len(h.history))
				copy(historyMsg.History, h.history)
				
				historyJSON, _ := json.Marshal(historyMsg)
				client.send <- historyJSON
			}
			h.mutex.Unlock()
			
		case client := <-h.unregister:
			h.mutex.Lock()
			if _, ok := h.clients[client]; ok {
				delete(h.clients, client)
				close(client.send)
				
				// Only send left message if they had a username (had fully joined)
				if client.username != "" {
					// Send system message that user has left
					leaveMsg := ChatMessage{
						Type:     SystemMessage,
						Message:  client.username + " has left the chat",
						Time:     time.Now().Format("15:04:05"),
					}
					leaveMsgJSON, _ := json.Marshal(leaveMsg)
					h.saveToChatHistory(leaveMsg)
					
					// Get updated active users list
					userList := make([]string, 0, len(h.clients))
					for c := range h.clients {
						if c.username != "" {
							userList = append(userList, c.username)
						}
					}
					
					// Send presence update
					presenceMsg := ChatMessage{
						Type:  PresenceMessage,
						Users: userList,
						Time:  time.Now().Format("15:04:05"),
					}
					presenceMsgJSON, _ := json.Marshal(presenceMsg)
					
					// Broadcast both messages
					for c := range h.clients {
						select {
						case c.send <- leaveMsgJSON:
							c.send <- presenceMsgJSON
						default:
							close(c.send)
							delete(h.clients, c)
						}
					}
				}
			}
			h.mutex.Unlock()
			
		case message := <-h.broadcast:
			h.mutex.Lock()
			// Parse the message to determine its type
			var chatMsg ChatMessage
			if err := json.Unmarshal(message, &chatMsg); err != nil {
				log.Printf("Error unmarshaling message: %v", err)
				h.mutex.Unlock()
				continue
			}
			
			// If it's a text message, add to history
			if chatMsg.Type == TextMessage {
				h.saveToChatHistory(chatMsg)
			}
			
			// Broadcast to all clients
			for client := range h.clients {
				select {
				case client.send <- message:
				default:
					close(client.send)
					delete(h.clients, client)
				}
			}
			h.mutex.Unlock()
		}
	}
}

// Add a message to chat history, maintaining max size
func (h *Hub) saveToChatHistory(msg ChatMessage) {
	// Only store actual chat messages and system messages
	if msg.Type == TextMessage || msg.Type == SystemMessage {
		// Maintain fixed size - remove oldest if we're at capacity
		if len(h.history) >= 50 {
			h.history = h.history[1:]
		}
		h.history = append(h.history, msg)
	}
}

// writePump pumps messages from the hub to the websocket connection
func (c *Client) writePump() {
	ticker := time.NewTicker(60 * time.Second)
	defer func() {
		ticker.Stop()
		c.conn.Close()
	}()

	for {
		select {
		case message, ok := <-c.send:
			c.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if !ok {
				// The hub closed the channel
				c.conn.WriteMessage(websocket.CloseMessage, []byte{})
				return
			}

			w, err := c.conn.NextWriter(websocket.TextMessage)
			if err != nil {
				return
			}
			w.Write(message)

			// Add any queued messages
			n := len(c.send)
			for i := 0; i < n; i++ {
				w.Write([]byte{'\n'})
				w.Write(<-c.send)
			}

			if err := w.Close(); err != nil {
				return
			}
		case <-ticker.C:
			c.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
			if err := c.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}

// readPump pumps messages from the websocket connection to the hub
func (c *Client) readPump(hub *Hub) {
	defer func() {
		hub.unregister <- c
		c.conn.Close()
	}()

	c.conn.SetReadLimit(1024) // Max message size
	c.conn.SetReadDeadline(time.Now().Add(90 * time.Second))
	c.conn.SetPongHandler(func(string) error {
		c.conn.SetReadDeadline(time.Now().Add(90 * time.Second))
		return nil
	})

	// Read username from the first message
	_, message, err := c.conn.ReadMessage()
	if err != nil {
		log.Println("Error reading username:", err)
		return
	}
	c.username = string(message)
	
	// Prepare a user joined message
	joinMsg := ChatMessage{
		Type:     SystemMessage,
		Message:  c.username + " has joined the chat",
		Time:     time.Now().Format("15:04:05"),
	}
	joinMsgJSON, _ := json.Marshal(joinMsg)
	hub.broadcast <- joinMsgJSON
	
	// Save to chat history
	hub.mutex.Lock()
	hub.saveToChatHistory(joinMsg)
	hub.mutex.Unlock()

	// Handle incoming messages
	for {
		_, message, err := c.conn.ReadMessage()
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseAbnormalClosure) {
				log.Printf("Error reading message: %v", err)
			}
			break
		}

		// Parse the message
		var rawMsg map[string]interface{}
		if err := json.Unmarshal(message, &rawMsg); err != nil {
			log.Printf("Error parsing message: %v", err)
			continue
		}

		// Check message type
		messageType, ok := rawMsg["type"].(string)
		if !ok {
			// Default to text message
			messageType = string(TextMessage)
		}

		switch MessageType(messageType) {
		case TextMessage:
			// Regular chat message
			chatMsg := ChatMessage{
				Type:     TextMessage,
				Username: c.username,
				Message:  rawMsg["message"].(string),
				Time:     time.Now().Format("15:04:05"),
				ID:       time.Now().UnixNano(),
			}
			msgJSON, _ := json.Marshal(chatMsg)
			hub.broadcast <- msgJSON
			
		case TypingMessage:
			// Typing indicator
			isTyping, ok := rawMsg["isTyping"].(bool)
			if !ok {
				continue
			}
			
			c.isTyping = isTyping
			
			typingMsg := ChatMessage{
				Type:     TypingMessage,
				Username: c.username,
				IsTyping: isTyping,
				Time:     time.Now().Format("15:04:05"),
			}
			msgJSON, _ := json.Marshal(typingMsg)
			hub.broadcast <- msgJSON
		}
	}
}

func serveWs(hub *Hub, w http.ResponseWriter, r *http.Request) {
	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Println("Error upgrading connection:", err)
		return
	}

	client := &Client{
		conn:     conn,
		send:     make(chan []byte, 256),
		username: "",
		isTyping: false,
	}
	hub.register <- client

	// Run the pumps in separate goroutines
	go client.writePump()
	go client.readPump(hub)
}

func main() {
	hub := newHub()
	go hub.run()

	// Serve static files
	http.HandleFunc("/", func(w http.ResponseWriter, r *http.Request) {
		http.ServeFile(w, r, "chat.html")
	})

	// WebSocket endpoint
	http.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		serveWs(hub, w, r)
	})

	// Start the server
	port := "8080"
	log.Printf("Server starting on :%s", port)
	log.Fatal(http.ListenAndServe(":"+port, nil))
}
```

You'll need to update the `chat.html` file as well to handle these new features. Here's the updated client-side code:

```html
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Go WebSocket Chat</title>
    <style>
        body {
            font-family: Arial, sans-serif;
            margin: 0;
            padding: 0;
            height: 100vh;
            display: flex;
            flex-direction: column;
        }
        .container {
            max-width: 1000px;
            margin: 0 auto;
            padding: 20px;
            flex-grow: 1;
            display: flex;
            flex-direction: column;
            width: 100%;
        }
        .header {
            padding: 10px 0;
            border-bottom: 1px solid #ccc;
            margin-bottom: 15px;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        .chat-container {
            display: flex;
            flex-grow: 1;
            gap: 20px;
        }
        .sidebar {
            width: 200px;
            border: 1px solid #ccc;
            border-radius: 4px;
            padding: 10px;
            background-color: #f9f9f9;
        }
        .sidebar h3 {
            margin-top: 0;
            border-bottom: 1px solid #ddd;
            padding-bottom: 10px;
        }
        .user-list {
            list-style-type: none;
            padding: 0;
        }
        .user-list li {
            padding: 5px 0;
            border-bottom: 1px solid #eee;
        }
        #chat-window {
            flex-grow: 1;
            overflow-y: auto;
            border: 1px solid #ccc;
            padding: 10px;
            margin-bottom: 15px;
            border-radius: 4px;
            background-color: #f9f9f9;
            height: 400px;
        }
        .typing-indicator {
            font-style: italic;
            color: #666;
            padding: 5px 10px;
            height: 20px;
        }
        #message-form {
            display: flex;
            margin-bottom: 15px;
        }
        #message-input {
            flex-grow: 1;
            padding: 10px;
            border: 1px solid #ccc;
            border-radius: 4px;
            margin-right: 10px;
        }
        button {
            padding: 10px 15px;
            background-color: #4CAF50;
            color: white;
            border: none;
            border-radius: 4px;
            cursor: pointer;
        }
        button:hover {
            background-color: #45a049;
        }
        .message {
            margin-bottom: 10px;
            padding: 8px 12px;
            border-radius: 4px;
            max-width: 70%;
            clear: both;
        }
        .own-message {
            background-color: #dcf8c6;
            float: right;
        }
        .other-message {
            background-color: #f2f2f2;
            float: left;
        }
        .message .time {
            font-size: 0.8em;
            color: #666;
            margin-left: 5px;
        }
        .message .username {
            font-weight: bold;
            margin-right: 5px;
        }
        .system-message {
            color: #666;
            font-style: italic;
            text-align: center;
            margin: 10px 0;
            clear: both;
        }
        .user-container {
            text-align: center;
            padding: 20px;
        }
        #username-form {
            display: inline-block;
        }
        #username-input {
            padding: 10px;
            border: 1px solid #ccc;
            border-radius: 4px;
            margin-right: 10px;
            width: 200px;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="header">
            <h1>Go WebSocket Chat</h1>
            <div id="connection-status">Disconnected</div>
        </div>
        
        <!-- Username form (shown first) -->
        <div id="user-container" class="user-container">
            <h2>Enter your username to join the chat</h2>
            <form id="username-form">
                <input type="text" id="username-input" placeholder="Username" required>
                <button type="submit">Join Chat</button>
            </form>
        </div>
        
        <!-- Chat interface (hidden until username is entered) -->
        <div id="chat-interface" style="display: none; flex-grow: 1; display: flex; flex-direction: column;">
            <div class="chat-container">
                <div class="sidebar">
                    <h3>Online Users</h3>
                    <ul id="user-list" class="user-list"></ul>
                </div>
                <div style="display: flex; flex-direction: column; flex-grow: 1;">
                    <div id="chat-window"></div>
                    <div id="typing-indicator" class="typing-indicator"></div>
                    <form id="message-form">
                        <input type="text" id="message-input" placeholder="Type a message..." autocomplete="off" required>
                        <button type="submit">Send</button>
                    </form>
                </div>
            </div>
        </div>
    </div>
    
    <script>
        const userContainer = document.getElementById('user-container');
        const chatInterface = document.getElementById('chat-interface');
        const usernameForm = document.getElementById('username-form');
        const usernameInput = document.getElementById('username-input');
        const chatWindow = document.getElementById('chat-window');
        const messageForm = document.getElementById('message-form');
        const messageInput = document.getElementById('message-input');
        const userList = document.getElementById('user-list');
        const typingIndicator = document.getElementById('typing-indicator');
        const connectionStatus = document.getElementById('connection-status');
        
        let socket = null;
        let username = '';
        let typingTimeout = null;
        let reconnectInterval = null;
        let typingUsers = new Set();
        
        // Handle username submission
        usernameForm.addEventListener('submit', (e) => {
            e.preventDefault();
            username = usernameInput.value.trim();
            if (username) {
                // Hide username form and show chat interface
                userContainer.style.display = 'none';
                chatInterface.style.display = 'flex';
                
                // Connect to WebSocket
                connectWebSocket();
            }
        });
        
        function connectWebSocket() {
            if (reconnectInterval) {
                clearInterval(reconnectInterval);
                reconnectInterval = null;
            }
            
            // Create WebSocket connection
            socket = new WebSocket(`ws://${window.location.host}/ws`);
            
            // Connection opened
            socket.addEventListener('open', (event) => {
                connectionStatus.textContent = 'Connected';
                connectionStatus.style.color = '#4CAF50';
                
                // Send username as the first message
                socket.send(username);
            });
            
            // Listen for messages
            socket.addEventListener('message', (event) => {
                try {
                    // Split messages if multiple are sent at once
                    const messages = event.data.split('\n');
                    for (const msgData of messages) {
                        if (!msgData.trim()) continue;
                        
                        const message = JSON.parse(msgData);
                        handleMessage(message);
                    }
                } catch (error) {
                    console.error('Error parsing message:', error);
                }
            });
            
            // Connection closed
            socket.addEventListener('close', (event) => {
                connectionStatus.textContent = 'Disconnected';
                connectionStatus.style.color = 'red';
                
                addSystemMessage('Disconnected from server. Trying to reconnect...');
                
                if (!reconnectInterval) {
                    reconnectInterval = setInterval(connectWebSocket, 3000);
                }
            });
            
            // Connection error
            socket.addEventListener('error', (event) => {
                connectionStatus.textContent = 'Error';
                connectionStatus.style.color = 'red';
                console.error('WebSocket error:', event);
            });
        }
        
        function handleMessage(message) {
            switch (message.type) {
                case 'message':
                    displayChatMessage(message);
                    break;
                case 'system':
                    addSystemMessage(message.message);
                    break;
                case 'typing':
                    updateTypingIndicator(message.username, message.isTyping);
                    break;
                case 'presence':
                    updateUserList(message.users);
                    break;
                case 'history':
                    displayMessageHistory(message.history);
                    break;
                default:
                    console.log('Unknown message type:', message.type);
            }
        }
        
        function displayChatMessage(message) {
            const isOwnMessage = message.username === username;
            
            const messageDiv = document.createElement('div');
            messageDiv.className = `message ${isOwnMessage ? 'own-message' : 'other-message'}`;
            
            const usernameSpan = document.createElement('span');
            usernameSpan.className = 'username';
            usernameSpan.textContent = message.username;
            usernameSpan.style.color = isOwnMessage ? '#009688' : '#2196F3';
            
            const contentSpan = document.createElement('span');
            contentSpan.className = 'content';
            contentSpan.textContent = message.message;
            
            const timeSpan = document.createElement('span');
            timeSpan.className = 'time';
            timeSpan.textContent = message.time;
            
            messageDiv.appendChild(usernameSpan);
            messageDiv.appendChild(contentSpan);
            messageDiv.appendChild(timeSpan);
            
            chatWindow.appendChild(messageDiv);
            scrollToBottom();
        }
        
        function addSystemMessage(text) {
            const systemDiv = document.createElement('div');
            systemDiv.className = 'system-message';
            systemDiv.textContent = text;
            chatWindow.appendChild(systemDiv);
            scrollToBottom();
        }
        
        function updateTypingIndicator(user, isTyping) {
            if (user === username) return; // Don't show typing for own messages
            
            if (isTyping) {
                typingUsers.add(user);
            } else {
                typingUsers.delete(user);
            }
            
            if (typingUsers.size === 0) {
                typingIndicator.textContent = '';
            } else if (typingUsers.size === 1) {
                typingIndicator.textContent = `${Array.from(typingUsers)[0]} is typing...`;
            } else {
                typingIndicator.textContent = `${typingUsers.size} people are typing...`;
            }
        }
        
        function updateUserList(users) {
            userList.innerHTML = '';
            
            users.forEach(user => {
                const li = document.createElement('li');
                li.textContent = user;
                if (user === username) {
                    li.style.fontWeight = 'bold';
                }
                userList.appendChild(li);
            });
        }
        
        function displayMessageHistory(history) {
            // Clear existing messages
            chatWindow.innerHTML = '';
            
            // Display history messages
            if (history && history.length > 0) {
                history.forEach(msg => {
                    if (msg.type === 'message') {
                        displayChatMessage(msg);
                    } else if (msg.type === 'system') {
                        addSystemMessage(msg.message);
                    }
                });
                
                addSystemMessage('--- End of message history ---');
            }
        }
        
        function scrollToBottom() {
            chatWindow.scrollTop = chatWindow.scrollHeight;
        }
        
        // Handle message submission
        messageForm.addEventListener('submit', (e) => {
            e.preventDefault();
            const message = messageInput.value.trim();
            if (message && socket && socket.readyState === WebSocket.OPEN) {
                // Send the message
                const chatMsg = {
                    type: 'message',
                    message: message
                };
                socket.send(JSON.stringify(chatMsg));
                messageInput.value = '';
                
                // Send typing stopped indicator
                sendTypingStatus(false);
            }
        });
        
        // Handle typing indicator
        messageInput.addEventListener('input', (e) => {
            if (socket && socket.readyState === WebSocket.OPEN) {
                // Clear existing timeout
                if (typingTimeout) {
                    clearTimeout(typingTimeout);
                }
                
                // Send typing started indicator
                sendTypingStatus(true);
                
                // Set timeout to send typing stopped after delay
                typingTimeout = setTimeout(() => {
                    sendTypingStatus(false);
                }, 2000);
            }
        });
        
        function sendTypingStatus(isTyping) {
            if (socket && socket.readyState === WebSocket.OPEN) {
                const typingMsg = {
                    type: 'typing',
                    isTyping: isTyping
                };
                socket.send(JSON.stringify(typingMsg));
            }
        }
    </script>
</body>
</html>
```

## Scaling WebSocket Applications

As your WebSocket application grows, you'll face scaling challenges. Here are strategies to handle them:

### 1. Connection Pooling

When dealing with thousands of concurrent connections, use connection pooling for database and cache access:

```go
// Example using database/sql connection pool
db, err := sql.Open("postgres", "postgres://user:password@localhost/db")
if err != nil {
    log.Fatal(err)
}

// Set maximum number of concurrent open connections
db.SetMaxOpenConns(100)
// Set maximum number of idle connections
db.SetMaxIdleConns(25)
// Set maximum lifetime of a connection
db.SetConnMaxLifetime(5 * time.Minute)
```

### 2. Horizontally Scaling with Redis Pub/Sub

To scale across multiple servers, use Redis Pub/Sub for message broadcasting:

```go
package main

import (
    "context"
    "log"
    
    "github.com/go-redis/redis/v8"
    "github.com/gorilla/websocket"
)

var redisClient *redis.Client
var ctx = context.Background()

func setupRedis() {
    redisClient = redis.NewClient(&redis.Options{
        Addr: "localhost:6379",
    })
    
    // Test connection
    if _, err := redisClient.Ping(ctx).Result(); err != nil {
        log.Fatalf("Failed to connect to Redis: %v", err)
    }
}

func (h *Hub) redisSubscribe() {
    pubsub := redisClient.Subscribe(ctx, "chat")
    defer pubsub.Close()
    
    for {
        msg, err := pubsub.ReceiveMessage(ctx)
        if err != nil {
            log.Printf("Redis receive error: %v", err)
            continue
        }
        
        // Broadcast message to all clients connected to this server
        h.broadcast <- []byte(msg.Payload)
    }
}

func (h *Hub) publishMessage(message []byte) {
    if err := redisClient.Publish(ctx, "chat", message).Err(); err != nil {
        log.Printf("Redis publish error: %v", err)
    }
}

// In the readPump function, replace hub.broadcast <- msgJSON with:
hub.publishMessage(msgJSON)
```

### 3. Load Balancing

To distribute connections across multiple servers, use a load balancer with WebSocket support:

- **Nginx Configuration for WebSockets**:

```nginx
http {
    map $http_upgrade $connection_upgrade {
        default upgrade;
        '' close;
    }
    
    upstream websocket {
        server app1:8080;
        server app2:8080;
        server app3:8080;
    }
    
    server {
        listen 80;
        
        location /ws {
            proxy_pass http://websocket;
            proxy_http_version 1.1;
            proxy_set_header Upgrade $http_upgrade;
            proxy_set_header Connection $connection_upgrade;
            proxy_set_header Host $host;
            proxy_set_header X-Real-IP $remote_addr;
        }
        
        location / {
            proxy_pass http://websocket;
        }
    }
}
```

### 4. Connection Health Monitoring

Implement proper connection health monitoring:

```go
func (c *Client) writePump() {
    ticker := time.NewTicker(60 * time.Second)
    pingTicker := time.NewTicker(30 * time.Second)
    defer func() {
        ticker.Stop()
        pingTicker.Stop()
        c.conn.Close()
    }()

    for {
        select {
        case message, ok := <-c.send:
            // Handle message sending...
            
        case <-pingTicker.C:
            // Send ping to check connection health
            c.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
            if err := c.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
                return
            }
            
        case <-ticker.C:
            // Send heartbeat message
            heartbeat := struct {
                Type string `json:"type"`
                Time int64  `json:"time"`
            }{
                Type: "heartbeat",
                Time: time.Now().UnixNano() / int64(time.Millisecond),
            }
            
            data, _ := json.Marshal(heartbeat)
            c.conn.SetWriteDeadline(time.Now().Add(10 * time.Second))
            if err := c.conn.WriteMessage(websocket.TextMessage, data); err != nil {
                return
            }
        }
    }
}
```

## Best Practices for WebSocket Applications

### 1. Implement Proper Authentication and Authorization

```go
// Authentication middleware
func authMiddleware(next http.Handler) http.Handler {
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        token := r.Header.Get("Authorization")
        if token == "" {
            token = r.URL.Query().Get("token")
        }
        
        if token == "" {
            http.Error(w, "Unauthorized", http.StatusUnauthorized)
            return
        }
        
        // Validate token
        userID, err := validateToken(token)
        if err != nil {
            http.Error(w, "Invalid token", http.StatusUnauthorized)
            return
        }
        
        // Store user info in context
        ctx := context.WithValue(r.Context(), "userID", userID)
        next.ServeHTTP(w, r.WithContext(ctx))
    })
}

// In your WebSocket handler
func serveWs(hub *Hub, w http.ResponseWriter, r *http.Request) {
    // Get user ID from context
    userID, ok := r.Context().Value("userID").(string)
    if !ok {
        http.Error(w, "Unauthorized", http.StatusUnauthorized)
        return
    }
    
    // Create WebSocket connection
    // ...
}
```

### 2. Implement Rate Limiting

```go
func rateLimitMiddleware(next http.Handler) http.Handler {
    // Create a limiter for each client
    var (
        limiters = make(map[string]*rate.Limiter)
        mu       sync.Mutex
    )
    
    return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
        // Identify the client (by IP or user ID)
        clientID := r.RemoteAddr
        
        // Get or create rate limiter for this client
        mu.Lock()
        limiter, exists := limiters[clientID]
        if !exists {
            // 10 requests per second with a burst of 20
            limiter = rate.NewLimiter(10, 20)
            limiters[clientID] = limiter
        }
        mu.Unlock()
        
        // Rate limit the request
        if !limiter.Allow() {
            http.Error(w, "Too many requests", http.StatusTooManyRequests)
            return
        }
        
        next.ServeHTTP(w, r)
    })
}
```

### 3. Implement Graceful Shutdown

```go
func main() {
    // Setup server
    hub := newHub()
    go hub.run()
    
    // Create HTTP server
    server := &http.Server{
        Addr: ":8080",
        Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
            if r.URL.Path == "/ws" {
                serveWs(hub, w, r)
            } else {
                http.ServeFile(w, r, "index.html")
            }
        }),
    }
    
    // Start server in a goroutine
    go func() {
        if err := server.ListenAndServe(); err != nil && err != http.ErrServerClosed {
            log.Fatalf("Server error: %v", err)
        }
    }()
    
    // Handle graceful shutdown
    stop := make(chan os.Signal, 1)
    signal.Notify(stop, os.Interrupt, syscall.SIGTERM)
    
    <-stop
    log.Println("Shutting down server...")
    
    // Create a deadline for shutdown
    ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
    defer cancel()
    
    // Shutdown the server
    if err := server.Shutdown(ctx); err != nil {
        log.Fatalf("Server forced to shutdown: %v", err)
    }
    
    log.Println("Server gracefully stopped")
}
```

### 4. Use Compression for Large Messages

```go
// Configure the upgrader with compression
var upgrader = websocket.Upgrader{
    ReadBufferSize:  1024,
    WriteBufferSize: 1024,
    CheckOrigin: func(r *http.Request) bool {
        return true
    },
    EnableCompression: true,
}

// Client-side
const socket = new WebSocket("ws://localhost:8080/ws");
socket.binaryType = "arraybuffer";
// Modern browsers automatically handle WebSocket compression
```

## Conclusion

Building real-time applications with Go and WebSockets provides a powerful combination for creating responsive, high-performance systems that can scale to handle thousands of concurrent connections. Go's concurrency model, with lightweight goroutines and channels, makes it an excellent choice for WebSocket servers.

In this guide, we've covered:

1. Creating a basic WebSocket server with Go
2. Building a real-time chat application
3. Adding advanced features like typing indicators and presence
4. Strategies for scaling WebSocket applications
5. Best practices for production-ready WebSocket servers

The examples provided offer a solid foundation for building your own real-time applications. By leveraging Go's strengths and following the patterns outlined here, you can create robust, efficient WebSocket services that deliver excellent user experiences.

Remember that WebSockets are just one tool for real-time communication. Depending on your requirements, you might also want to explore Server-Sent Events (SSE) for one-way communication or gRPC for high-performance, bidirectional streaming. However, for many real-time applications, the combination of Go and WebSockets offers an excellent balance of performance, simplicity, and capability.