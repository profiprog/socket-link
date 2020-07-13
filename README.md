# socket-link
Allow simply setup socket communication between processes


## Usage
```npm istall --save @profiprog/socket-link```

### Server side
```js
const { startService, ErrorResponse } import('@profiprog/socket-link');
const socketPath = './myapp.sock';

function isValid(name) { return name[0].toUpperCase(0) === name[0]; }

startService(socketPath, ({ id, body }) => {
    console.log(`Request(${id}):`, body);
    if (isValid(body.name)) return { greeting: 'Hello ' + body.name };
    else throw new ErrorResponse('Invalid name', { name });
});
```

### Clinet side
```js
const { requestService } import('@profiprog/socket-link');
const socketPath = './myapp.sock';

// one request per connection
requestService(socketPath, { body: { name: 'Socket' } })
    .then(({ greeting }) => console.log(greeting))
    .catch(e => console.error(e));

// multiple requests per connection
requestService(socketPath, async call => {
    try {
        let { greeting: greetingForAdam } = await call({name: 'Adam'});
        let { greeting: greetingForEva } = await call({name: 'Eva'});
        console.log({greetingForAdam, greetingForEva});
    }
    catch (error) { console.error(error); }
});

// start interactive shell
const readline = require('readline');
requestService(socketPath, readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: '> ',
}));
```
