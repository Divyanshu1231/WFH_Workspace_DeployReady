import React, { useState } from 'react';
import Employee from './Employee';
import Admin from './Admin';
import { socket } from './socket';

export default function App() {
  const [role, setRole] = useState(null);
  const back = () => { socket.disconnect(); socket.connect(); setRole(null); };

  if (!role) {
    return (
      <div className="center"><div className="panel">
        <h1>WFH Workspace</h1>
        <p>Employee attendance and live screen workspace</p>
        <button onClick={() => setRole('employee')}>👨‍💻 Employee</button>
        <button className="secondary" onClick={() => setRole('admin')}>👨‍💼 Admin</button>
      </div></div>
    );
  }
  return role === 'admin' ? <Admin onBack={back} /> : <Employee onBack={back} />;
}
