import React, { createContext, useContext, useEffect, useState } from 'react';
import io from 'socket.io-client';
import { BACKEND_URL } from '../lib/config';

const SocketContext = createContext(null);

export const useSocket = () => {
  return useContext(SocketContext);
};

export const SocketProvider = ({ children }) => {
  const [socket, setSocket] = useState(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    const newSocket = io(BACKEND_URL, {
      transports: ['websocket', 'polling'],
      withCredentials: true,
    });

    newSocket.on('connect', () => {
      console.log('Socket connected');
      setConnected(true);
    });

    newSocket.on('disconnect', () => {
      console.log('Socket disconnected');
      setConnected(false);
    });

    setSocket(newSocket);

    return () => {
      newSocket.close();
    };
  }, []);

  const joinRoom = (room) => {
    if (socket) {
      socket.emit('join_room', { room });
    }
  };

  return (
    <SocketContext.Provider value={{ socket, connected, joinRoom }}>
      {children}
    </SocketContext.Provider>
  );
};
