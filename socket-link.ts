import * as net from 'net';
import { once } from 'events';
import { Interface } from 'readline';

export interface MessageOK {
	/**
	 * Every request message has automatically asigned id at server side.
	 */
	id?: string;
	body: any;
	emptyResponse?: true;
}
export interface MessageError {
	id?: string; 
	error: string;
	type: string;
	invalidResponse?: string;
	stack?: string;
	details?: any;
}
export type Message =  MessageOK | MessageError;
/**
 * Function provided to client allowing multiple call from server.
 */
export type CallService = (requestPayload: any) => Promise<any>
export type SericeClient = (call: CallService) => Promise<any>;

export class ErrorResponse extends Error {
	public details: any;
	constructor(msg: string, details?: any) {
		super(msg);
		if (details !== undefined) Object.assign(this, {details});
	}
}

export class RemoteError extends Error {
	public id: string;
	constructor({error, stack, ...rest}: MessageError) {
		super(error);
		this.stack = stack ? this.name + ': ' + stack : '';
		Object.assign(this, rest);
	}
}

interface MessageReaderContext {
	reqestIdGenerator(prefix?: string): string;
}
async function* messagesReader(
	this: MessageReaderContext|void,
	socket: net.Socket & {id?: string},
): AsyncGenerator<Message, void> {
		let buffer: string[] = [];
	while (true) {
		let data: string|null = await Promise.race([
			once(socket, 'data').then(([_]) => _),
			once(socket, 'end').then(() => null),
		]);
		if (data === null) break;
		let chunks: string[] = data.split('\n');
		for (let i = 0; i < chunks.length; i++) {
			buffer.push(chunks[i]);
			if (i + 1 < chunks.length)  {
				let rawBody: string = buffer.splice(0, buffer.length).join('');
				let message: Message = { body: null, emptyResponse: true }; // empty response
				if (rawBody.length) {
					try { message = JSON.parse(rawBody); }
					catch (e) { message = { error: e.message, type: e.name, invalidResponse: rawBody }; }
				}
				if (message && this && this.reqestIdGenerator) message.id = this.reqestIdGenerator(socket.id);
				// console.log(">>>", message); //inspect incoming messages on both sides (server and client)
				yield message;
			}
		}
	}
}

interface ServiceOpts {
	on: string;
	connetionIdGenerator?: CounterIdGen;
	serviceId?: string;
	idGenerator?: () => CounterIdGen;
	reqestIdGenerator?: () => CounterIdGen;
	log?: true | ((message: string) => void);
	/**
	 * Enable send stack trace of server exceptions.
	 */
	traceErrors?: boolean;
}

interface Service extends net.Server {
	id: string;
	stop: (signal: string) => void;
	whenStop: () => Promise<void>;
}
interface Connection extends net.Socket {
	id: string;
	requests: () => AsyncIterator<Message>;
	sendResult: (message: Message) => void;
}

type ServiceHandler = (message: MessageOK) => any;

export function startService(options: string | ServiceOpts, handler?: ServiceHandler): Service {
	let opts: ServiceOpts = typeof options === 'string' ? { on: options } : options;
	let connectionIdGenerator: CounterIdGen = opts.connetionIdGenerator || opts.idGenerator && opts.idGenerator() || counter(16);
	let connections = new Set<Connection>();
	let logger = opts.log === true ? console.log.bind(console) : opts.log || (() => {});
	
	let service = <Service>net.createServer((connection: Connection): void => {
		connections.add(connection);
		connection.on('end', () => connections.delete(connection));
		
		connection.id = connectionIdGenerator(service.id);
		if (opts.log) {
			logger(`client ${connection.id} connected`);
			connection.on('end', () => logger(`client ${connection.id} disconnected`));
		}
		connection.setEncoding('utf8');
		connection.requests = messagesReader.bind({
			reqestIdGenerator:
				opts.reqestIdGenerator && opts.reqestIdGenerator() ||
				opts.idGenerator && opts.idGenerator() ||
				counter(16),
		}, connection);
		connection.sendResult = function (data: Message) {
			this.write(JSON.stringify(data) + '\n');
		};
		service.emit('connect', connection);
	});
	if (!opts.serviceId) service.id = `${require('os').hostname()}.${Date.now().toString(16)}`;
	if (opts.log) {
		service.on('start', () => logger(`Service ${service.id} started (${opts.on})`));
		service.on('stop', signal => logger(`Service ${service.id} stoped by '${signal}'`));
	}
	service.stop = signal => {
		service.close(() => service.emit('stop', signal));
		for (let con of connections) con.end();
	};
	process.on('SIGINT', service.stop.bind(service));
	if (handler) {
		service.on('connect', async connetion => {
			for await (let request of connetion.requests()) {
				let response: Message;
				try { response = { body: handler(request) }; }
				catch (e) { logger(e); response = asMessageError(e, opts.traceErrors); }
				connetion.sendResult(Object.assign({ id: request.id }, response));
			}
		});
	}
	service.listen(opts.on, () => service.emit('start'));
	service.whenStop = () => <Promise<any>>once(service, 'stop');
	return service;
}

function asMessageError(e: any, addStack = false) {
	let response: MessageError;
	if (e instanceof Error) {
		response = { error: e.message, type: e.name };
		if (e instanceof ErrorResponse) response.details = e.details;
		else if (addStack) response.stack = e.stack;
	}
	else if (typeof e === 'string') response = { error: e, type: 'string' };
	else if (e && e.toString) response = { error: e.toString(), type: 'object', details: e };
	else response = { error: 'unknown error', type: 'unknown', details: e };
	return response;
}

export type CounterIdGen = {readonly count: number} & ((prefix?: string) => string);
export function counter(radix = 10): CounterIdGen {
	let result = Object.assign(
		(prefix = '', join = '.') => (prefix ? prefix + join : '') + (result.count++).toString(radix),
		{count: 0},
	);
	return result;
}
	
function createReply(rl: Interface, whenEnd: Promise<any>): SericeClient {
	whenEnd.then(() => { whenEnd = null as any; rl.close(); });
	
	return async (call: CallService) => {
		rl.on('close', () => {
			// https://www.lihaoyi.com/post/BuildyourownCommandLinewithANSIescapecodes.html
			process.stdout.write('\x1b[0G\x1b[2K'); // clear current line
			if (!whenEnd) console.log('connection closed by server.');
		});
		
		while (true) {
			rl.prompt();
			let line: string | null = await Promise.race([
				once(rl, 'line').then(([_]) => _),
				once(rl, 'close').then(() => null),
			]);
			if (line === null) break;
			try { console.log(await call(line)); }
			catch (e) { console.log(e); }
		}
		rl.close();
	}
}

export async function requestService(
	on: net.NetConnectOpts | string,
	callerOrBody: Interface | SericeClient | any,
) {
	let client: net.Socket = net.createConnection(on as any);
	
	let whenError: Promise<any[]> = once(client, 'error');
	whenError.then(([e]: [Error]) => console.error(e));
	client.setEncoding('utf8');

	
	let isConnected: boolean = await Promise.race([
		once(client, 'connect').then(() => true),
		whenError.then(() => false),
	]);
	let reader = messagesReader(client);
	let whenClose: Promise<any> = once(client, 'close').catch(() => {});
	let caller: SericeClient = 
		typeof callerOrBody === 'function' ? callerOrBody :
		callerOrBody instanceof require('readline').Interface ? createReply(callerOrBody, whenClose) :
		((call: SericeClient) => call(callerOrBody));
	
	if (!isConnected) return;
	let result = await caller((body: any) => {
		client.write(JSON.stringify({ body }) + '\n');
		return reader.next().then(({value, done}) => {
			if (done) return null;
			if ((value as MessageError).error) throw new RemoteError(value as MessageError);
			return (value as MessageOK).body;
		});
	});
	client.end();
	await whenClose;
	return result;
}


if (module === require.main) {
	const fail = <(msg: string) => string>((msg: string) => { console.log('Error:', msg); process.exit(1); });
	const argOf = (opt: string, defaultValue: string = ''): string => {
		let i = process.argv.indexOf(opt) + 1;
		return i > 0 ?
			process.argv[i] || fail('Missing argument for option ' + opt) :
			defaultValue || fail('Missing required option ' + opt);
	};
	let socketPath = argOf('--socket', 'link.sock');
	if (process.argv.find(a => a.includes('--service'))) {
		startService({ on: socketPath, log: true, traceErrors: true }, ({id, body: name}) => {
			console.log(`request ${id}> ${name}`);
			if (name[0].toUpperCase() === name[0]) return 'Hello ' + name;
			throw new ErrorResponse('Name is invalid (should start with cappital char)', {name});
		});
	}
	else {
		let msg = argOf('--send', '\0');
		if (msg !== '\0') requestService(socketPath, {body: msg}).then(response => { console.log(response.body); });
		else requestService(socketPath, require('readline').createInterface({
			input: process.stdin,
			output: process.stdout,
			prompt: '> ',
		}));	
	}	  
}
