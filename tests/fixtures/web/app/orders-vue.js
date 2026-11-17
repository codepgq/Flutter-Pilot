import { createApp, ref, h } from 'vue';
createApp({
  setup() {
    const amount = ref(''),
      ready = ref(''),
      result = ref(''),
      order = ref('');
    let socket;
    const button = (id, onClick) => h('button', { 'data-testid': id, onClick }, id);
    return () => [
      h('input', {
        'data-testid': 'amount',
        value: amount.value,
        onInput: (e) => (amount.value = e.target.value),
      }),
      button('fetch', async () => (result.value = (await (await fetch('/value')).json()).marker)),
      button('connect', () => {
        socket?.close();
        socket = new WebSocket(location.origin.replace('http', 'ws') + '/orders');
        socket.onopen = () => (ready.value = 'ready');
        socket.onmessage = (e) => {
          const v = JSON.parse(e.data);
          order.value = v.orderId + ' ' + v.status;
        };
      }),
      button('confirm', async () => {
        const v = await (
          await fetch('/orders', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ amount: amount.value }),
          })
        ).json();
        result.value = v.code ?? v.orderId;
      }),
      ...[
        ['ready', ready],
        ['result', result],
        ['order', order],
      ].map(([id, value]) => h('p', { 'data-testid': id }, value.value)),
    ];
  },
}).mount('#app');
