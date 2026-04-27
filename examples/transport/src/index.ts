const worker1 = new Worker('./examples/transport/dist/worker1.js', {
  env: {
    id: 'worker1',
  },
})
const worker2 = new Worker('./examples/transport/dist/worker2.js', {
  env: {
    id: 'worker2',
  },
})

worker1.addEventListener('error', ev => {
  console.log('worker1', ev)
})

worker2.addEventListener('error', ev => {
  console.log('worker2', ev)
})

// oxlint-disable-next-line unicorn/require-module-specifiers
export {}
