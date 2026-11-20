import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './style.css';
import { loadIceServers, loadServerConfig, wakeFaceService, getAttendanceMode } from './config';

loadIceServers();
loadServerConfig().then(() => { if (getAttendanceMode() === 'face') wakeFaceService(); }); // wake the sleeping Render face service in the background

createRoot(document.getElementById('root')).render(<App />);
