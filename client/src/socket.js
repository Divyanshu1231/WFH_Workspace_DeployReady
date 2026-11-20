import { useEffect, useState } from 'react';
import { io } from 'socket.io-client';
import { SERVER_URL } from './config';

export const socket = io(SERVER_URL);

export function useConnected() {
  const [connected, setConnected] = useState(socket.connected);
  useEffect(() => {
    const on = () => setConnected(true), off = () => setConnected(false);
    socket.on('connect', on);
    socket.on('disconnect', off);
    return () => { socket.off('connect', on); socket.off('disconnect', off); };
  }, []);
  return connected;
}
