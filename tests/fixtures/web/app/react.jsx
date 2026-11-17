import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
function App() {
  const [value, setValue] = useState(''),
    [done, setDone] = useState('');
  return (
    <>
      <input
        data-testid="entry"
        value={value}
        onChange={(event) => {
          setValue(event.target.value);
          fetch('/event?kind=input');
        }}
      />
      <button
        data-testid="submit"
        onClick={() => {
          setDone('Submitted ' + value);
          fetch('/submit?value=' + encodeURIComponent(value));
        }}
      >
        Submit
      </button>
      <p data-testid="result">{done}</p>
    </>
  );
}
createRoot(document.getElementById('app')).render(<App />);
