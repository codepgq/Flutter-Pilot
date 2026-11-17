import { createApp, ref, h } from 'vue';
createApp({
  setup() {
    const value = ref(''),
      done = ref('');
    return () => [
      h('input', {
        'data-testid': 'entry',
        value: value.value,
        onInput: (event) => {
          value.value = event.target.value;
          fetch('/event?kind=input');
        },
      }),
      h(
        'button',
        {
          'data-testid': 'submit',
          onClick: () => {
            done.value = 'Submitted ' + value.value;
            fetch('/submit?value=' + encodeURIComponent(value.value));
          },
        },
        'Submit',
      ),
      h('p', { 'data-testid': 'result' }, done.value),
    ];
  },
}).mount('#app');
