import React, { useState, useRef } from 'react';
import { createRoot } from 'react-dom/client';
function App() {
  const [value, setValue] = useState(''),
    [ready, setReady] = useState(''),
    [result, setResult] = useState(''),
    [order, setOrder] = useState('');
  const socket = useRef();
  return (
    <>
      <input data-testid="amount" value={value} onChange={(e) => setValue(e.target.value)} />
      <button
        data-testid="fetch"
        onClick={async () => setResult((await (await fetch('/value')).json()).marker)}
      >
        Fetch
      </button>
      <button
        data-testid="connect"
        onClick={() => {
          socket.current?.close();
          socket.current = new WebSocket(location.origin.replace('http', 'ws') + '/orders');
          socket.current.onopen = () => setReady('ready');
          socket.current.onmessage = (e) => {
            const v = JSON.parse(e.data);
            setOrder(v.orderId + ' ' + v.status);
          };
        }}
      >
        Connect
      </button>
      <button
        data-testid="confirm"
        onClick={async () => {
          const v = await (
            await fetch('/orders', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ amount: value }),
            })
          ).json();
          setResult(v.code ?? v.orderId);
        }}
      >
        Confirm
      </button>
      <p data-testid="ready">{ready}</p>
      <p data-testid="result">{result}</p>
      <p data-testid="order">{order}</p>
    </>
  );
}
createRoot(document.getElementById('app')).render(<App />);
