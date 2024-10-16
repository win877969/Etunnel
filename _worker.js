// <!--GAMFC-->version base on commit c17ceb86be8e16c53fcfdf4b7dcd09e9e372863b, time is 2023-06-05 18:02:59 UTC<!--GAMFC-END-->.
// @ts-ignore
import { connect } from 'cloudflare:sockets';

// How to generate your own UUID:
// [Windows] Press "Win + R", input cmd and run:  Powershell -NoExit -Command "[guid]::NewGuid()"
let userID = 'd342d11e-d424-4583-b36e-524ab1f0afa4';

let proxyIP = "64.68.192." + Math.floor(Math.random() * 255);

if (!isValidUUID(userID)) {
	throw new Error('uuid is not valid');
}

export default {
	/**
	 * @param {import("@cloudflare/workers-types").Request} request
	 * @param {{UUID: string, PROXYIP: string}} env
	 * @param {import("@cloudflare/workers-types").ExecutionContext} ctx
	 * @returns {Promise<Response>}
	 */
	async fetch(request, env, ctx) {
		try {
			userID = env.UUID || userID;
			proxyIP = env.PROXYIP || proxyIP;
			const upgradeHeader = request.headers.get('Upgrade');
			if (!upgradeHeader || upgradeHeader !== 'websocket') {
				const url = new URL(request.url);
				switch (url.pathname) {
					case '/':
						return new Response(JSON.stringify(request.cf), { status: 200 });
					case `/${userID}`: {
						const vlessConfig = getVLESSConfig(userID, request.headers.get('Host'));
						return new Response(`${vlessConfig}`, {
							status: 200,
							headers: {
								"Content-Type": "text/plain;charset=utf-8",
							}
						});
					}
					default:
						return new Response('Not found', { status: 404 });
				}
			} else {
				return await vlessOverWSHandler(request);
			}
		} catch (err) {
			/** @type {Error} */ let e = err;
			return new Response(e.toString());
		}
	},
};




/**
 * 
 * @param {import("@cloudflare/workers-types").Request} request
 */
async function vlessOverWSHandler(request) {

	/** @type {import("@cloudflare/workers-types").WebSocket[]} */
	// @ts-ignore
	const webSocketPair = new WebSocketPair();
	const [client, webSocket] = Object.values(webSocketPair);

	webSocket.accept();

	let address = '';
	let portWithRandomLog = '';
	const log = (/** @type {string} */ info, /** @type {string | undefined} */ event) => {
		console.log(`[${address}:${portWithRandomLog}] ${info}`, event || '');
	};
	const earlyDataHeader = request.headers.get('sec-websocket-protocol') || '';

	const readableWebSocketStream = makeReadableWebSocketStream(webSocket, earlyDataHeader, log);

	/** @type {{ value: import("@cloudflare/workers-types").Socket | null}}*/
	let remoteSocketWapper = {
		value: null,
	};
	let isDns = false;

	// ws --> remote
	readableWebSocketStream.pipeTo(new WritableStream({
		async write(chunk, controller) {
			if (isDns) {
				return await handleDNSQuery(chunk, webSocket, null, log);
			}
			if (remoteSocketWapper.value) {
				const writer = remoteSocketWapper.value.writable.getWriter()
				await writer.write(chunk);
				writer.releaseLock();
				return;
			}

			const {
				hasError,
				message,
				portRemote = 443,
				addressRemote = '',
				rawDataIndex,
				vlessVersion = new Uint8Array([0, 0]),
				isUDP,
			} = processVlessHeader(chunk, userID);
			address = addressRemote;
			portWithRandomLog = `${portRemote}--${Math.random()} ${isUDP ? 'udp ' : 'tcp '
				} `;
			if (hasError) {
				// controller.error(message);
				throw new Error(message); // cf seems has bug, controller.error will not end stream
				// webSocket.close(1000, message);
				return;
			}
			// if UDP but port not DNS port, close it
			if (isUDP) {
				if (portRemote === 53) {
					isDns = true;
				} else {
					// controller.error('UDP proxy only enable for DNS which is port 53');
					throw new Error('UDP proxy only enable for DNS which is port 53'); // cf seems has bug, controller.error will not end stream
					return;
				}
			}
			// ["version", "附加信息长度 N"]
			const vlessResponseHeader = new Uint8Array([vlessVersion[0], 0]);
			const rawClientData = chunk.slice(rawDataIndex);

			if (isDns) {
				return handleDNSQuery(rawClientData, webSocket, vlessResponseHeader, log);
			}
			handleTCPOutBound(remoteSocketWapper, addressRemote, portRemote, rawClientData, webSocket, vlessResponseHeader, log);
		},
		close() {
			log(`readableWebSocketStream is close`);
		},
		abort(reason) {
			log(`readableWebSocketStream is abort`, JSON.stringify(reason));
		},
	})).catch((err) => {
		log('readableWebSocketStream pipeTo error', err);
	});

	return new Response(null, {
		status: 101,
		// @ts-ignore
		webSocket: client,
	});
}

/**
 * Handles outbound TCP connections.
 *
 * @param {any} remoteSocket 
 * @param {string} addressRemote The remote address to connect to.
 * @param {number} portRemote The remote port to connect to.
 * @param {Uint8Array} rawClientData The raw client data to write.
 * @param {import("@cloudflare/workers-types").WebSocket} webSocket The WebSocket to pass the remote socket to.
 * @param {Uint8Array} vlessResponseHeader The VLESS response header.
 * @param {function} log The logging function.
 * @returns {Promise<void>} The remote socket.
 */
async function handleTCPOutBound(remoteSocket, addressRemote, portRemote, rawClientData, webSocket, vlessResponseHeader, log,) {
	async function connectAndWrite(address, port) {
		/** @type {import("@cloudflare/workers-types").Socket} */
		const tcpSocket = connect({
			hostname: address,
			port: port,
		});
		remoteSocket.value = tcpSocket;
		log(`connected to ${address}:${port}`);
		const writer = tcpSocket.writable.getWriter();
		await writer.write(rawClientData); // first write, nomal is tls client hello
		writer.releaseLock();
		return tcpSocket;
	}

	// if the cf connect tcp socket have no incoming data, we retry to redirect ip
	async function retry() {
		const tcpSocket = await connectAndWrite(proxyIP || addressRemote, portRemote)
		// no matter retry success or not, close websocket
		tcpSocket.closed.catch(error => {
			console.log('retry tcpSocket closed error', error);
		}).finally(() => {
			safeCloseWebSocket(webSocket);
		})
		remoteSocketToWS(tcpSocket, webSocket, vlessResponseHeader, null, log);
	}

	const tcpSocket = await connectAndWrite(addressRemote, portRemote);

	// when remoteSocket is ready, pass to websocket
	// remote--> ws
	remoteSocketToWS(tcpSocket, webSocket, vlessResponseHeader, retry, log);
}

/**
 * 
 * @param {import("@cloudflare/workers-types").WebSocket} webSocketServer
 * @param {string} earlyDataHeader for ws 0rtt
 * @param {(info: string)=> void} log for ws 0rtt
 */
function makeReadableWebSocketStream(webSocketServer, earlyDataHeader, log) {
	let readableStreamCancel = false;
	const stream = new ReadableStream({
		start(controller) {
			webSocketServer.addEventListener('message', (event) => {
				if (readableStreamCancel) {
					return;
				}
				const message = event.data;
				controller.enqueue(message);
			});

			// The event means that the client closed the client -> server stream.
			// However, the server -> client stream is still open until you call close() on the server side.
			// The WebSocket protocol says that a separate close message must be sent in each direction to fully close the socket.
			webSocketServer.addEventListener('close', () => {
				// client send close, need close server
				// if stream is cancel, skip controller.close
				safeCloseWebSocket(webSocketServer);
				if (readableStreamCancel) {
					return;
				}
				controller.close();
			}
			);
			webSocketServer.addEventListener('error', (err) => {
				log('webSocketServer has error');
				controller.error(err);
			}
			);
			// for ws 0rtt
			const { earlyData, error } = base64ToArrayBuffer(earlyDataHeader);
			if (error) {
				controller.error(error);
			} else if (earlyData) {
				controller.enqueue(earlyData);
			}
		},

		pull(controller) {
			// if ws can stop read if stream is full, we can implement backpressure
			// https://streams.spec.whatwg.org/#example-rs-push-backpressure
		},
		cancel(reason) {
			// 1. pipe WritableStream has error, this cancel will called, so ws handle server close into here
			// 2. if readableStream is cancel, all controller.close/enqueue need skip,
			// 3. but from testing controller.error still work even if readableStream is cancel
			if (readableStreamCancel) {
				return;
			}
			log(`ReadableStream was canceled, due to ${reason}`)
			readableStreamCancel = true;
			safeCloseWebSocket(webSocketServer);
		}
	});

	return stream;

}

// https://xtls.github.io/development/protocols/vless.html
// https://github.com/zizifn/excalidraw-backup/blob/main/v2ray-protocol.excalidraw

/**
 * 
 * @param { ArrayBuffer} vlessBuffer 
 * @param {string} userID 
 * @returns 
 */
function processVlessHeader(
	vlessBuffer,
	userID
) {
	if (vlessBuffer.byteLength < 24) {
		return {
			hasError: true,
			message: 'invalid data',
		};
	}
	const version = new Uint8Array(vlessBuffer.slice(0, 1));
	let isValidUser = false;
	let isUDP = false;
	if (stringify(new Uint8Array(vlessBuffer.slice(1, 17))) === userID) {
		isValidUser = true;
	}
	if (!isValidUser) {
		return {
			hasError: true,
			message: 'invalid user',
		};
	}

	const optLength = new Uint8Array(vlessBuffer.slice(17, 18))[0];
	//skip opt for now

	const command = new Uint8Array(
		vlessBuffer.slice(18 + optLength, 18 + optLength + 1)
	)[0];

	// 0x01 TCP
	// 0x02 UDP
	// 0x03 MUX
	if (command === 1) {
	} else if (command === 2) {
		isUDP = true;
	} else {
		return {
			hasError: true,
			message: `command ${command} is not support, command 01-tcp,02-udp,03-mux`,
		};
	}
	const portIndex = 18 + optLength + 1;
	const portBuffer = vlessBuffer.slice(portIndex, portIndex + 2);
	// port is big-Endian in raw data etc 80 == 0x005d
	const portRemote = new DataView(portBuffer).getUint16(0);

	let addressIndex = portIndex + 2;
	const addressBuffer = new Uint8Array(
		vlessBuffer.slice(addressIndex, addressIndex + 1)
	);

	// 1--> ipv4  addressLength =4
	// 2--> domain name addressLength=addressBuffer[1]
	// 3--> ipv6  addressLength =16
	const addressType = addressBuffer[0];
	let addressLength = 0;
	let addressValueIndex = addressIndex + 1;
	let addressValue = '';
	switch (addressType) {
		case 1:
			addressLength = 4;
			addressValue = new Uint8Array(
				vlessBuffer.slice(addressValueIndex, addressValueIndex + addressLength)
			).join('.');
			break;
		case 2:
			addressLength = new Uint8Array(
				vlessBuffer.slice(addressValueIndex, addressValueIndex + 1)
			)[0];
			addressValueIndex += 1;
			addressValue = new TextDecoder().decode(
				vlessBuffer.slice(addressValueIndex, addressValueIndex + addressLength)
			);
			break;
		case 3:
			addressLength = 16;
			const dataView = new DataView(
				vlessBuffer.slice(addressValueIndex, addressValueIndex + addressLength)
			);
			// 2001:0db8:85a3:0000:0000:8a2e:0370:7334
			const ipv6 = [];
			for (let i = 0; i < 8; i++) {
				ipv6.push(dataView.getUint16(i * 2).toString(16));
			}
			addressValue = ipv6.join(':');
			// seems no need add [] for ipv6
			break;
		default:
			return {
				hasError: true,
				message: `invild  addressType is ${addressType}`,
			};
	}
	if (!addressValue) {
		return {
			hasError: true,
			message: `addressValue is empty, addressType is ${addressType}`,
		};
	}

	return {
		hasError: false,
		addressRemote: addressValue,
		addressType,
		portRemote,
		rawDataIndex: addressValueIndex + addressLength,
		vlessVersion: version,
		isUDP,
	};
}


/**
 * 
 * @param {import("@cloudflare/workers-types").Socket} remoteSocket 
 * @param {import("@cloudflare/workers-types").WebSocket} webSocket 
 * @param {ArrayBuffer} vlessResponseHeader 
 * @param {(() => Promise<void>) | null} retry
 * @param {*} log 
 */
async function remoteSocketToWS(remoteSocket, webSocket, vlessResponseHeader, retry, log) {
	// remote--> ws
	let remoteChunkCount = 0;
	let chunks = [];
	/** @type {ArrayBuffer | null} */
	let vlessHeader = vlessResponseHeader;
	let hasIncomingData = false; // check if remoteSocket has incoming data
	await remoteSocket.readable
		.pipeTo(
			new WritableStream({
				start() {
				},
				/**
				 * 
				 * @param {Uint8Array} chunk 
				 * @param {*} controller 
				 */
				async write(chunk, controller) {
					hasIncomingData = true;
					// remoteChunkCount++;
					if (webSocket.readyState !== WS_READY_STATE_OPEN) {
						controller.error(
							'webSocket.readyState is not open, maybe close'
						);
					}
					if (vlessHeader) {
						webSocket.send(await new Blob([vlessHeader, chunk]).arrayBuffer());
						vlessHeader = null;
					} else {
						// seems no need rate limit this, CF seems fix this??..
						// if (remoteChunkCount > 20000) {
						// 	// cf one package is 4096 byte(4kb),  4096 * 20000 = 80M
						// 	await delay(1);
						// }
						webSocket.send(chunk);
					}
				},
				close() {
					log(`remoteConnection!.readable is close with hasIncomingData is ${hasIncomingData}`);
					// safeCloseWebSocket(webSocket); // no need server close websocket frist for some case will casue HTTP ERR_CONTENT_LENGTH_MISMATCH issue, client will send close event anyway.
				},
				abort(reason) {
					console.error(`remoteConnection!.readable abort`, reason);
				},
			})
		)
		.catch((error) => {
			console.error(
				`remoteSocketToWS has exception `,
				error.stack || error
			);
			safeCloseWebSocket(webSocket);
		});

	// seems is cf connect socket have error,
	// 1. Socket.closed will have error
	// 2. Socket.readable will be close without any data coming
	if (hasIncomingData === false && retry) {
		log(`retry`)
		retry();
	}
}

/**
 * 
 * @param {string} base64Str 
 * @returns 
 */
function base64ToArrayBuffer(base64Str) {
	if (!base64Str) {
		return { error: null };
	}
	try {
		// go use modified Base64 for URL rfc4648 which js atob not support
		base64Str = base64Str.replace(/-/g, '+').replace(/_/g, '/');
		const decode = atob(base64Str);
		const arryBuffer = Uint8Array.from(decode, (c) => c.charCodeAt(0));
		return { earlyData: arryBuffer.buffer, error: null };
	} catch (error) {
		return { error };
	}
}

/**
 * This is not real UUID validation
 * @param {string} uuid 
 */
function isValidUUID(uuid) {
	const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[4][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
	return uuidRegex.test(uuid);
}

const WS_READY_STATE_OPEN = 1;
const WS_READY_STATE_CLOSING = 2;
/**
 * Normally, WebSocket will not has exceptions when close.
 * @param {import("@cloudflare/workers-types").WebSocket} socket
 */
function safeCloseWebSocket(socket) {
	try {
		if (socket.readyState === WS_READY_STATE_OPEN || socket.readyState === WS_READY_STATE_CLOSING) {
			socket.close();
		}
	} catch (error) {
		console.error('safeCloseWebSocket error', error);
	}
}

const byteToHex = [];
for (let i = 0; i < 256; ++i) {
	byteToHex.push((i + 256).toString(16).slice(1));
}
function unsafeStringify(arr, offset = 0) {
	return (byteToHex[arr[offset + 0]] + byteToHex[arr[offset + 1]] + byteToHex[arr[offset + 2]] + byteToHex[arr[offset + 3]] + "-" + byteToHex[arr[offset + 4]] + byteToHex[arr[offset + 5]] + "-" + byteToHex[arr[offset + 6]] + byteToHex[arr[offset + 7]] + "-" + byteToHex[arr[offset + 8]] + byteToHex[arr[offset + 9]] + "-" + byteToHex[arr[offset + 10]] + byteToHex[arr[offset + 11]] + byteToHex[arr[offset + 12]] + byteToHex[arr[offset + 13]] + byteToHex[arr[offset + 14]] + byteToHex[arr[offset + 15]]).toLowerCase();
}
function stringify(arr, offset = 0) {
	const uuid = unsafeStringify(arr, offset);
	if (!isValidUUID(uuid)) {
		throw TypeError("Stringified UUID is invalid");
	}
	return uuid;
}

/**
 * 
 * @param {ArrayBuffer} udpChunk 
 * @param {import("@cloudflare/workers-types").WebSocket} webSocket 
 * @param {ArrayBuffer} vlessResponseHeader 
 * @param {(string)=> void} log 
 */
async function handleDNSQuery(udpChunk, webSocket, vlessResponseHeader, log) {
	// no matter which DNS server client send, we alwasy use hard code one.
	// beacsue someof DNS server is not support DNS over TCP
	try {
		const dnsServer = '8.8.4.4'; // change to 1.1.1.1 after cf fix connect own ip bug
		const dnsPort = 53;
		/** @type {ArrayBuffer | null} */
		let vlessHeader = vlessResponseHeader;
		/** @type {import("@cloudflare/workers-types").Socket} */
		const tcpSocket = connect({
			hostname: dnsServer,
			port: dnsPort,
		});

		log(`connected to ${dnsServer}:${dnsPort}`);
		const writer = tcpSocket.writable.getWriter();
		await writer.write(udpChunk);
		writer.releaseLock();
		await tcpSocket.readable.pipeTo(new WritableStream({
			async write(chunk) {
				if (webSocket.readyState === WS_READY_STATE_OPEN) {
					if (vlessHeader) {
						webSocket.send(await new Blob([vlessHeader, chunk]).arrayBuffer());
						vlessHeader = null;
					} else {
						webSocket.send(chunk);
					}
				}
			},
			close() {
				log(`dns server(${dnsServer}) tcp is close`);
			},
			abort(reason) {
				console.error(`dns server(${dnsServer}) tcp is abort`, reason);
			},
		}));
	} catch (error) {
		console.error(
			`handleDNSQuery have exception, error: ${error.message}`
		);
	}
}

/**
 * 
 * @param {string} userID 
 * @param {string | null} hostName
 * @returns {string}
 */
function getVLESSConfig(userID, hostName) {
	const vlessMain = `vless://${userID}@${hostName}:443?encryption=none&security=tls&sni=${hostName}&fp=randomized&type=ws&host=${hostName}&path=%2Fvl%3D35.219.15.90#${hostName}`
	return `
################################################################
v2ray
---------------------------------------------------------------
${vlessMain}
---------------------------------------------------------------
################################################################
clash-meta
---------------------------------------------------------------
- type: vless
  name: ${hostName}
  server: ${hostName}
  port: 443
  uuid: ${userID}
  network: ws
  tls: true
  udp: false
  sni: ${hostName}
  client-fingerprint: chrome
  ws-opts:
    path: "/vl=35.219.15.90"
    headers:
      host: ${hostName}
---------------------------------------------------------------
################################################################


<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=no">
    <title>Vless | Noir7R | CLoudFlare</title>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.0.0-beta3/css/all.min.css" integrity="sha512-Fo3rlrZj/k7ujTnHg4C+6PCWJ+8zzHcXQjXGp6n5Yh9rX0x5fOdPaOqO+e2X4R5C1aE/BSqPIG+8y3O6APa8w==" crossorigin="anonymous" referrerpolicy="no-referrer" />
    <link rel="icon" href="https://raw.githubusercontent.com/AFRcloud/BG/main/icons8-film-noir-80.png" type="image/png">
    <style>
        @import url('https://fonts.googleapis.com/css2?family=Poppins:wght@300;400;600&display=swap');

        body {
            margin: 0;
            padding: 0;
            font-family: 'Poppins', sans-serif;
            color: #f5f5f5;
            background-color: black;
            display: flex;
            align-items: center;
            flex-direction: column;
            min-height: 100vh;
            overflow: hidden;
        }

        .container {
            max-width: 1200px;
            width: 100%;
            margin: 3px;
            background: rgba(0, 0, 0, 0.9);
            backdrop-filter: blur(8px);
            -webkit-backdrop-filter: blur(8px);
            animation: fadeIn 1s ease-in-out;
            overflow-y: auto;
            max-height: 100vh;
        }

        .overlay {
            position: fixed;
            top: 0;
            left: 0;
            width: 100%;
            height: 100%;
            background: rgba(15, 15, 15, 0.4);
            z-index: -1;
        }

        @keyframes fadeIn {
            from { opacity: 0; transform: translateY(20px); }
            to { opacity: 1; transform: translateY(0); }
        }

        .header {
            text-align: center;
            margin-bottom: 40px;
            margin-top: 10px;
        }

        .header h1 {
            font-size: 42px;
            color: yellow;
            margin: 0;
            font-weight: 700;
            text-transform: uppercase;
            letter-spacing: 4px;
        }

        .nav-buttons {
            display: flex;
            justify-content: center;
            margin-top: 20px;
            margin-bottom: 20px;
            gap: 10px;
        }

        .nav-buttons .button {
            background-color: transparent;
            border: 3px solid yellow;
            color: yellow;
            padding: 6px 12px;
            font-size: 20px;
            border-radius: 4px;
            cursor: pointer;
            transition: all 0.3s ease;
            text-transform: uppercase;
            letter-spacing: 3px;
        }

        .nav-buttons .button:hover {
            background-color: yellow;
            color: #fff;
            transform: scale(1.05);
        }

        .content {
            display: none;
            opacity: 0;
            transition: opacity 0.5s ease-in-out;
        }

        .content.active {
            display: block;
            opacity: 1;
        }

        .config-section {
            background: rgba(0, 0, 0, 0.5);
            padding: 20px;
            margin-right: 5px;
            margin-left: 5px;
            border: 2px solid yellow;
            border-radius: 10px;
            position: relative;
            animation: slideIn 0.5s ease-in-out;
        }

        @keyframes slideIn {
            from { transform: translateX(-30px); opacity: 0; }
            to { transform: translateX(0); opacity: 1; }
        }

        .config-section h3 {
            margin-top: 0;
            color: #e1b12c;
            font-size: 28px;
        }

        .config-section p {
            color: #f5f5f5;
            font-size: 16px;
        }

        .config-toggle {
            margin-bottom: 10px;
        }

        .config-content {
            display: none;
        }

        .config-content.active {
            display: block;
        }

        .config-block {
            margin-bottom: 10px;
            padding: 15px;
            border-radius: 10px;
            background-color: rgba(0, 0, 0, 0.2);
            transition: background-color 0.3s ease;
        }

        .config-block h4 {
            margin-bottom: 8px;
            color: #f39c12;
            font-size: 22px;
            font-weight: 600;
        }

        .config {
            background-color: rgba(0, 0, 0, 0.2);
            padding: 15px;
            border-radius: 5px;
            border: 2px solid yellow;
            color: #f5f5f5;
            word-wrap: break-word;
            white-space: pre-wrap;
            font-family: 'Courier New', Courier, monospace;
            font-size: 15px;
        }
        .button {
            background-color: transparent;
            border: 2px solid yellow;
            color: yellow;
            padding: 4px 8px;
            font-size: 12px;
            border-radius: 3px;
            cursor: pointer;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            transition: all 0.3s ease;
            text-transform: uppercase;
            letter-spacing: 1.5px;
            margin-right: 4px;
        }

        .button i {
            margin-right: 3px;
        }

        .button:hover {
            background-color: yellow;
            color: #fff;
            transform: scale(1.0);
        }

        .config-divider {
            border: none;
            height: 1px;
            background: linear-gradient(to right, transparent, #fff, transparent);
            margin: 20px 0;
        }
        .watermark {
            position: absolute;
            bottom: 20px;
            left: 50%;
            transform: translateX(-50%);
            font-size: 0.8rem;
            color: rgba(255, 255, 255, 0.5);
            text-shadow: 1px 1px 2px rgba(0, 0, 0, 0.5);
            font-weight: bold;
            text-align: center;
        }
        .watermark a {
            color: #ffa500;
            text-decoration: none;
            font-weight: bold;
        }
        .watermark a:hover {
            color: #ffa500;
        }

        @media (max-width: 768px) {
            .header h1 {
                font-size: 32px;
            }

            .config-section h3 {
                font-size: 24px;
            }

            .config-block h4 {
                font-size: 20px;
            }

            .domain-list {
                font-size: 10px;
            }
        }
    </style>
</head>
<body>
    <div class="overlay"></div>
    <div class="container">
        <div class="header">
            <h1>VLESS CLOUDFLARE</h1>
        </div>
        <div class="nav-buttons">
            <button class="button" onclick="showContent('vless')">List vless</button>
            <button class="button" onclick="showContent('clash')">List Clash</button>
        </div>
        <center><a href="https://t.me/bexnxx" class="button">Source</a> <a href="https://t.me/noir7r" class="button">Modded</a></center><br>
        <div class="config-section">
        <strong>LIST WILLCARD : </strong><br>
        <br>
        ✰ ava.game.naver.com<br>
        ✰ graph.instagram.com<br>
        ✰ quiz.int.vidio.com<br>
        ✰ live.iflix.com<br>
        ✰ support.zoom.us<br>
        ✰ blog.webex.com<br>
        ✰ cache.netflix.com<br>
        ✰ investors.spotify.com<br>
        ✰ zaintest.vuclip.com<br>
        </div>
        <hr class="config-divider" />
        <div id="vless" class="content active">
            <div class="config-section">
    <p><strong>ISP  :  Akamai Technologies, Inc. (ID) </strong> </p>
    <hr />
    <div class="config-toggle">
        <button class="button" onclick="toggleConfig(this, 'show vless', 'hide vless')">Show Vless</button>
        <div class="config-content">
            <div class="config-block">
                <h3>TLS:</h3>
                <p class="config">vless://<a href="/cdn-cgi/l/email-protection" class="__cf_email__" data-cfemail="f5cc97c5c494c7c0cdd8c09490c2d8c197c293d897c097c6d8c4c5cd97c09393c697c2c597b598988ddb83859b9a9c87cc87db8086db9e92">[email&#160;protected]</a>:443?encryption=none&security=tls&sni=mmx.vpnoir9r.us.kg&fp=randomized&type=ws&host=mmx.vpnoir9r.us.kg&path=%2Fid-akm#Akamai+Technologies,+Inc.+(ID)</p>
                <button class="button" onclick='copyToClipboard("vless://9b01a258-5ae7-4b7f-b5b3-108b5ff3b70b@mmx.vpnoir9r.us.kg:443?encryption=none&security=tls&sni=mmx.vpnoir9r.us.kg&fp=randomized&type=ws&host=mmx.vpnoir9r.us.kg&path=%2Fid-akm#Akamai+Technologies,+Inc.+(ID)")'><i class="fa fa-clipboard"></i>Copy</button>
            </div>
            <hr />
            <div class="config-block">
                <h3>NTLS:</h3>
                <p class="config">vless://<a href="/cdn-cgi/l/email-protection" class="__cf_email__" data-cfemail="cdfaa8fefafea9aef9e0f5fda9a9e0f9feabfee0f5abaffbe0a9f8abfaaeaffca9fbafa8f48da0a0b5e3bbbda3a2a4bff4bfe3b8bee3a6aa">[email&#160;protected]</a>:80?path=%2Fid-akm&security=none&encryption=none&host=mmx.vpnoir9r.us.kg&fp=randomized&type=ws&sni=mmx.vpnoir9r.us.kg#Akamai+Technologies,+Inc.+(ID)</p>
                <button class="button" onclick='copyToClipboard("vless://7e373dc4-80dd-43f3-8fb6-d5f7cb1d6be9@mmx.vpnoir9r.us.kg:80?path=%2Fid-akm&security=none&encryption=none&host=mmx.vpnoir9r.us.kg&fp=randomized&type=ws&sni=mmx.vpnoir9r.us.kg#Akamai+Technologies,+Inc.+(ID)")'><i class="fa fa-clipboard"></i>Copy</button>
            </div>
            <hr />
        </div>
    </div>
</div>
<hr class="config-divider" />
<div class="config-section">
    <p><strong>ISP  :  ByteVirt LLC (SG) </strong> </p>
    <hr />
    <div class="config-toggle">
        <button class="button" onclick="toggleConfig(this, 'show vless', 'hide vless')">Show Vless</button>
        <div class="config-content">
            <div class="config-block">
                <h3>TLS:</h3>
                <p class="config">vless://<a href="/cdn-cgi/l/email-protection" class="__cf_email__" data-cfemail="04603c3632676030332966313d3c293062313d293c3c3137293732336067303d313136303d4469697c2a72746a6b6d763d762a71772a6f63">[email&#160;protected]</a>:443?encryption=none&security=tls&sni=mmx.vpnoir9r.us.kg&fp=randomized&type=ws&host=mmx.vpnoir9r.us.kg&path=%2Fsg-byt#ByteVirt+LLC+(SG)</p>
                <button class="button" onclick='copyToClipboard("vless://d826cd47-b598-4f59-8853-367dc4955249@mmx.vpnoir9r.us.kg:443?encryption=none&security=tls&sni=mmx.vpnoir9r.us.kg&fp=randomized&type=ws&host=mmx.vpnoir9r.us.kg&path=%2Fsg-byt#ByteVirt+LLC+(SG)")'><i class="fa fa-clipboard"></i>Copy</button>
            </div>
            <hr />
            <div class="config-block">
                <h3>NTLS:</h3>
                <p class="config">vless://<a href="/cdn-cgi/l/email-protection" class="__cf_email__" data-cfemail="0163383038323264362c356264392c356367672c633530602c326363353939373134303030416c6c792f77716f6e687338732f74722f6a66">[email&#160;protected]</a>:80?path=%2Fsg-byt&security=none&encryption=none&host=mmx.vpnoir9r.us.kg&fp=randomized&type=ws&sni=mmx.vpnoir9r.us.kg#ByteVirt+LLC+(SG)</p>
                <button class="button" onclick='copyToClipboard("vless://b91933e7-4ce8-4bff-b41a-3bb488605111@mmx.vpnoir9r.us.kg:80?path=%2Fsg-byt&security=none&encryption=none&host=mmx.vpnoir9r.us.kg&fp=randomized&type=ws&sni=mmx.vpnoir9r.us.kg#ByteVirt+LLC+(SG)")'><i class="fa fa-clipboard"></i>Copy</button>
            </div>
            <hr />
        </div>
    </div>
</div>
<hr class="config-divider" />
<div class="config-section">
    <p><strong>ISP  :  Telekomunikasi Indonesia (ID) </strong> </p>
    <hr />
    <div class="config-toggle">
        <button class="button" onclick="toggleConfig(this, 'show vless', 'hide vless')">Show Vless</button>
        <div class="config-content">
            <div class="config-block">
                <h3>TLS:</h3>
                <p class="config">vless://<a href="/cdn-cgi/l/email-protection" class="__cf_email__" data-cfemail="a295c495959396c6c08f9bc4c3928f96c1c79a8fc09396958f90c39196c4939b94c4c395c1e2cfcfda8cd4d2cccdcbd09bd08cd7d18cc9c5">[email&#160;protected]</a>:443?encryption=none&security=tls&sni=mmx.vpnoir9r.us.kg&fp=randomized&type=ws&host=mmx.vpnoir9r.us.kg&path=%2Fid-tsel#Telekomunikasi+Indonesia+(ID)</p>
                <button class="button" onclick='copyToClipboard("vless://7f7714db-9fa0-4ce8-b147-2a34f196fa7c@mmx.vpnoir9r.us.kg:443?encryption=none&security=tls&sni=mmx.vpnoir9r.us.kg&fp=randomized&type=ws&host=mmx.vpnoir9r.us.kg&path=%2Fid-tsel#Telekomunikasi+Indonesia+(ID)")'><i class="fa fa-clipboard"></i>Copy</button>
            </div>
            <hr />
            <div class="config-block">
                <h3>NTLS:</h3>
                <p class="config">vless://<a href="/cdn-cgi/l/email-protection" class="__cf_email__" data-cfemail="e4dc858781d282dd86c9dcd2ddd0c9d0d682d3c9ddd581d3c9d28182d786d3d1d7d7d585d6a489899cca92948a8b8d96dd96ca9197ca8f83">[email&#160;protected]</a>:80?path=%2Fid-tsel&security=none&encryption=none&host=mmx.vpnoir9r.us.kg&fp=randomized&type=ws&sni=mmx.vpnoir9r.us.kg#Telekomunikasi+Indonesia+(ID)</p>
                <button class="button" onclick='copyToClipboard("vless://8ace6f9b-8694-42f7-91e7-6ef3b75331a2@mmx.vpnoir9r.us.kg:80?path=%2Fid-tsel&security=none&encryption=none&host=mmx.vpnoir9r.us.kg&fp=randomized&type=ws&sni=mmx.vpnoir9r.us.kg#Telekomunikasi+Indonesia+(ID)")'><i class="fa fa-clipboard"></i>Copy</button>
            </div>
            <hr />
        </div>
    </div>
</div>
<hr class="config-divider" />
<div class="config-section">
    <p><strong>ISP  :  Akamai International B.V. (SG) </strong> </p>
    <hr />
    <div class="config-toggle">
        <button class="button" onclick="toggleConfig(this, 'show vless', 'hide vless')">Show Vless</button>
        <div class="config-content">
            <div class="config-block">
                <h3>TLS:</h3>
                <p class="config">vless://<a href="/cdn-cgi/l/email-protection" class="__cf_email__" data-cfemail="0662306537303736652b60333f322b323263652b673465622b676263626767306331636732466b6b7e28707668696f743f74287375286d61">[email&#160;protected]</a>:443?encryption=none&security=tls&sni=mmx.vpnoir9r.us.kg&fp=randomized&type=ws&host=mmx.vpnoir9r.us.kg&path=%2Fsgaka1#Akamai+International+B.V.+(SG)</p>
                <button class="button" onclick='copyToClipboard("vless://d6c1610c-f594-44ec-a2cd-adedaa6e7ea4@mmx.vpnoir9r.us.kg:443?encryption=none&security=tls&sni=mmx.vpnoir9r.us.kg&fp=randomized&type=ws&host=mmx.vpnoir9r.us.kg&path=%2Fsgaka1#Akamai+International+B.V.+(SG)")'><i class="fa fa-clipboard"></i>Copy</button>
            </div>
            <hr />
            <div class="config-block">
                <h3>NTLS:</h3>
                <p class="config">vless://<a href="/cdn-cgi/l/email-protection" class="__cf_email__" data-cfemail="97a5f2f6f1a6a4f6afbaa7a1a7f4baa3aef3f2baaef5f1a5baf2a5f6f6a3aef6a1f2f2f1a0d7fafaefb9e1e7f9f8fee5aee5b9e2e4b9fcf0">[email&#160;protected]</a>:80?path=%2Fsgaka1&security=none&encryption=none&host=mmx.vpnoir9r.us.kg&fp=randomized&type=ws&sni=mmx.vpnoir9r.us.kg#Akamai+International+B.V.+(SG)</p>
                <button class="button" onclick='copyToClipboard("vless://2eaf13a8-060c-49de-9bf2-e2aa49a6eef7@mmx.vpnoir9r.us.kg:80?path=%2Fsgaka1&security=none&encryption=none&host=mmx.vpnoir9r.us.kg&fp=randomized&type=ws&sni=mmx.vpnoir9r.us.kg#Akamai+International+B.V.+(SG)")'><i class="fa fa-clipboard"></i>Copy</button>
            </div>
            <hr />
        </div>
    </div>
</div>
<hr class="config-divider" />
<div class="config-section">
    <p><strong>ISP  :  Akamai International B.V. (MY) </strong> </p>
    <hr />
    <div class="config-toggle">
        <button class="button" onclick="toggleConfig(this, 'show vless', 'hide vless')">Show Vless</button>
        <div class="config-content">
            <div class="config-block">
                <h3>TLS:</h3>
                <p class="config">vless://<a href="/cdn-cgi/l/email-protection" class="__cf_email__" data-cfemail="d3e5eab0e1e3e5e2b5fee1b0b2b7fee7b7eae0feb1e5b7e1feebe5e4ebb1eae3e5e4ebb5b593bebeabfda5a3bdbcbaa1eaa1fda6a0fdb8b4">[email&#160;protected]</a>:443?encryption=none&security=tls&sni=mmx.vpnoir9r.us.kg&fp=randomized&type=ws&host=mmx.vpnoir9r.us.kg&path=%2Fmy1#Akamai+International+B.V.+(MY)</p>
                <button class="button" onclick='copyToClipboard("vless://69c2061f-2cad-4d93-b6d2-8678b90678ff@mmx.vpnoir9r.us.kg:443?encryption=none&security=tls&sni=mmx.vpnoir9r.us.kg&fp=randomized&type=ws&host=mmx.vpnoir9r.us.kg&path=%2Fmy1#Akamai+International+B.V.+(MY)")'><i class="fa fa-clipboard"></i>Copy</button>
            </div>
            <hr />
            <div class="config-block">
                <h3>NTLS:</h3>
                <p class="config">vless://<a href="/cdn-cgi/l/email-protection" class="__cf_email__" data-cfemail="784f1c4c4a414d1c40554a19491d554c4a4148551a4d4e40551d1941404c484e194c1e4a4a38151500560e081617110a410a560d0b56131f">[email&#160;protected]</a>:80?path=%2Fmy1&security=none&encryption=none&host=mmx.vpnoir9r.us.kg&fp=randomized&type=ws&sni=mmx.vpnoir9r.us.kg#Akamai+International+B.V.+(MY)</p>
                <button class="button" onclick='copyToClipboard("vless://7d4295d8-2a1e-4290-b568-ea98406a4f22@mmx.vpnoir9r.us.kg:80?path=%2Fmy1&security=none&encryption=none&host=mmx.vpnoir9r.us.kg&fp=randomized&type=ws&sni=mmx.vpnoir9r.us.kg#Akamai+International+B.V.+(MY)")'><i class="fa fa-clipboard"></i>Copy</button>
            </div>
            <hr />
        </div>
    </div>
</div>
<hr class="config-divider" />
<div class="config-section">
    <p><strong>ISP  :  The Constant Company (SG) </strong> </p>
    <hr />
    <div class="config-toggle">
        <button class="button" onclick="toggleConfig(this, 'show vless', 'hide vless')">Show Vless</button>
        <div class="config-content">
            <div class="config-block">
                <h3>TLS:</h3>
                <p class="config">vless://<a href="/cdn-cgi/l/email-protection" class="__cf_email__" data-cfemail="b989dd888edd8a8988948bdd8ddf948d8f89da94db89dc8f94898b8b818ad881df8b8bdd8cf9d4d4c197cfc9d7d6d0cb80cb97ccca97d2de">[email&#160;protected]</a>:443?encryption=none&security=tls&sni=mmx.vpnoir9r.us.kg&fp=randomized&type=ws&host=mmx.vpnoir9r.us.kg&path=%2Fsgtcc#The+Constant+Company+(SG)</p>
                <button class="button" onclick='copyToClipboard("vless://0d17d301-2d4f-460c-b0e6-02283a8f22d5@mmx.vpnoir9r.us.kg:443?encryption=none&security=tls&sni=mmx.vpnoir9r.us.kg&fp=randomized&type=ws&host=mmx.vpnoir9r.us.kg&path=%2Fsgtcc#The+Constant+Company+(SG)")'><i class="fa fa-clipboard"></i>Copy</button>
            </div>
            <hr />
            <div class="config-block">
                <h3>NTLS:</h3>
                <p class="config">vless://<a href="/cdn-cgi/l/email-protection" class="__cf_email__" data-cfemail="4024722270702679266d702272256d742276756d787870246d712670227621237224742578002d2d386e36302e2f293279326e35336e2b27">[email&#160;protected]</a>:80?path=%2Fsgtcc&security=none&encryption=none&host=mmx.vpnoir9r.us.kg&fp=randomized&type=ws&sni=mmx.vpnoir9r.us.kg#The+Constant+Company+(SG)</p>
                <button class="button" onclick='copyToClipboard("vless://d2b00f9f-0b2e-4b65-880d-1f0b6ac2d4e8@mmx.vpnoir9r.us.kg:80?path=%2Fsgtcc&security=none&encryption=none&host=mmx.vpnoir9r.us.kg&fp=randomized&type=ws&sni=mmx.vpnoir9r.us.kg#The+Constant+Company+(SG)")'><i class="fa fa-clipboard"></i>Copy</button>
            </div>
            <hr />
        </div>
    </div>
</div>
<hr class="config-divider" />
<div class="config-section">
    <p><strong>ISP  :  Shenzhen Tencent Computer Systems Company Limited (SG) </strong> </p>
    <hr />
    <div class="config-toggle">
        <button class="button" onclick="toggleConfig(this, 'show vless', 'hide vless')">Show Vless</button>
        <div class="config-content">
            <div class="config-block">
                <h3>TLS:</h3>
                <p class="config">vless://<a href="/cdn-cgi/l/email-protection" class="__cf_email__" data-cfemail="2741134643111316170a1044101e0a1343451f0a464117420a174542464411161610151411674a4a5f09515749484e551e55095254094c40">[email&#160;protected]</a>:443?encryption=none&security=tls&sni=mmx.vpnoir9r.us.kg&fp=randomized&type=ws&host=mmx.vpnoir9r.us.kg&path=%2Fsgtencent#Shenzhen+Tencent+Computer+Systems+Company+Limited+(SG)</p>
                <button class="button" onclick='copyToClipboard("vless://f4ad6410-7c79-4db8-af0e-0beac6117236@mmx.vpnoir9r.us.kg:443?encryption=none&security=tls&sni=mmx.vpnoir9r.us.kg&fp=randomized&type=ws&host=mmx.vpnoir9r.us.kg&path=%2Fsgtencent#Shenzhen+Tencent+Computer+Systems+Company+Limited+(SG)")'><i class="fa fa-clipboard"></i>Copy</button>
            </div>
            <hr />
            <div class="config-block">
                <h3>NTLS:</h3>
                <p class="config">vless://<a href="/cdn-cgi/l/email-protection" class="__cf_email__" data-cfemail="442675737d2121747769257621746970757c76697c72737d697c7d737070222276737573250429293c6a32342a2b2d367d366a31376a2f23">[email&#160;protected]</a>:80?path=%2Fsgtencent&security=none&encryption=none&host=mmx.vpnoir9r.us.kg&fp=randomized&type=ws&sni=mmx.vpnoir9r.us.kg#Shenzhen+Tencent+Computer+Systems+Company+Limited+(SG)</p>
                <button class="button" onclick='copyToClipboard("vless://b179ee03-a2e0-4182-8679-89744ff2717a@mmx.vpnoir9r.us.kg:80?path=%2Fsgtencent&security=none&encryption=none&host=mmx.vpnoir9r.us.kg&fp=randomized&type=ws&sni=mmx.vpnoir9r.us.kg#Shenzhen+Tencent+Computer+Systems+Company+Limited+(SG)")'><i class="fa fa-clipboard"></i>Copy</button>
            </div>
            <hr />
        </div>
    </div>
</div>
<hr class="config-divider" />
<div class="config-section">
    <p><strong>ISP  :  iFog GmbH (SG) </strong> </p>
    <hr />
    <div class="config-toggle">
        <button class="button" onclick="toggleConfig(this, 'show vless', 'hide vless')">Show Vless</button>
        <div class="config-content">
            <div class="config-block">
                <h3>TLS:</h3>
                <p class="config">vless://<a href="/cdn-cgi/l/email-protection" class="__cf_email__" data-cfemail="685a090b580d5f5d5d450d0e0b50455c5f090b450959095f450e5f5d0c505d095c595f5f5d28050510461e180607011a511a461d1b46030f">[email&#160;protected]</a>:443?encryption=none&security=tls&sni=mmx.vpnoir9r.us.kg&fp=randomized&type=ws&host=mmx.vpnoir9r.us.kg&path=%2FIFOG#iFog+GmbH+(SG)</p>
                <button class="button" onclick='copyToClipboard("vless://2ac0e755-efc8-47ac-a1a7-f75d85a41775@mmx.vpnoir9r.us.kg:443?encryption=none&security=tls&sni=mmx.vpnoir9r.us.kg&fp=randomized&type=ws&host=mmx.vpnoir9r.us.kg&path=%2FIFOG#iFog+GmbH+(SG)")'><i class="fa fa-clipboard"></i>Copy</button>
            </div>
            <hr />
            <div class="config-block">
                <h3>NTLS:</h3>
                <p class="config">vless://<a href="/cdn-cgi/l/email-protection" class="__cf_email__" data-cfemail="ecd9dcdeddd8da8fddc189d9d9d9c1d888d9dbc1d5dad4ddc18e8ddad9ded5dedfd98a8d88ac818194c29a9c8283859ed59ec2999fc2878b">[email&#160;protected]</a>:80?path=%2FIFOG&security=none&encryption=none&host=mmx.vpnoir9r.us.kg&fp=randomized&type=ws&sni=mmx.vpnoir9r.us.kg#iFog+GmbH+(SG)</p>
                <button class="button" onclick='copyToClipboard("vless://502146c1-e555-4d57-9681-ba6529235fad@mmx.vpnoir9r.us.kg:80?path=%2FIFOG&security=none&encryption=none&host=mmx.vpnoir9r.us.kg&fp=randomized&type=ws&sni=mmx.vpnoir9r.us.kg#iFog+GmbH+(SG)")'><i class="fa fa-clipboard"></i>Copy</button>
            </div>
            <hr />
        </div>
    </div>
</div>
<hr class="config-divider" />
<div class="config-section">
    <p><strong>ISP  :  Ipxo LLC (SG) </strong> </p>
    <hr />
    <div class="config-toggle">
        <button class="button" onclick="toggleConfig(this, 'show vless', 'hide vless')">Show Vless</button>
        <div class="config-content">
            <div class="config-block">
                <h3>TLS:</h3>
                <p class="config">vless://<a href="/cdn-cgi/l/email-protection" class="__cf_email__" data-cfemail="7716434440434211405a4442414f5a431516425a151240425a4716154e4313124014124013371a1a0f59010719181e054e05590204591c10">[email&#160;protected]</a>:443?encryption=none&security=tls&sni=mmx.vpnoir9r.us.kg&fp=randomized&type=ws&host=mmx.vpnoir9r.us.kg&path=%2FREGXA#Ipxo+LLC+(SG)</p>
                <button class="button" onclick='copyToClipboard("vless://a43745f7-3568-4ba5-be75-0ab94de7ce7d@mmx.vpnoir9r.us.kg:443?encryption=none&security=tls&sni=mmx.vpnoir9r.us.kg&fp=randomized&type=ws&host=mmx.vpnoir9r.us.kg&path=%2FREGXA#Ipxo+LLC+(SG)")'><i class="fa fa-clipboard"></i>Copy</button>
            </div>
            <hr />
            <div class="config-block">
                <h3>NTLS:</h3>
                <p class="config">vless://<a href="/cdn-cgi/l/email-protection" class="__cf_email__" data-cfemail="c9affdadfaaafff1ade4adf0feafe4fdaafcfce4f1fef9f8e4aba8f9f0acafabaafcafabaf89a4a4b1e7bfb9a7a6a0bbf0bbe7bcbae7a2ae">[email&#160;protected]</a>:80?path=%2FREGXA&security=none&encryption=none&host=mmx.vpnoir9r.us.kg&fp=randomized&type=ws&sni=mmx.vpnoir9r.us.kg#Ipxo+LLC+(SG)</p>
                <button class="button" onclick='copyToClipboard("vless://f4d3c68d-d97f-4c55-8701-ba09efbc5fbf@mmx.vpnoir9r.us.kg:80?path=%2FREGXA&security=none&encryption=none&host=mmx.vpnoir9r.us.kg&fp=randomized&type=ws&sni=mmx.vpnoir9r.us.kg#Ipxo+LLC+(SG)")'><i class="fa fa-clipboard"></i>Copy</button>
            </div>
            <hr />
        </div>
    </div>
</div>
<hr class="config-divider" />
<div class="config-section">
    <p><strong>ISP  :  Contabo GmbH (SG) </strong> </p>
    <hr />
    <div class="config-toggle">
        <button class="button" onclick="toggleConfig(this, 'show vless', 'hide vless')">Show Vless</button>
        <div class="config-content">
            <div class="config-block">
                <h3>TLS:</h3>
                <p class="config">vless://<a href="/cdn-cgi/l/email-protection" class="__cf_email__" data-cfemail="d2e7b3b7b4e0e6ebe5ffe1e6e2eaffe6ebb0e6ffb0b0b0e1ffe3e4e6ebe5b1ebb7e5e7e0e292bfbfaafca4a2bcbdbba0eba0fca7a1fcb9b5">[email&#160;protected]</a>:443?encryption=none&security=tls&sni=mmx.vpnoir9r.us.kg&fp=randomized&type=ws&host=mmx.vpnoir9r.us.kg&path=%2FCONTABO-SG#Contabo+GmbH+(SG)</p>
                <button class="button" onclick='copyToClipboard("vless://5aef2497-3408-49b4-bbb3-16497c9e7520@mmx.vpnoir9r.us.kg:443?encryption=none&security=tls&sni=mmx.vpnoir9r.us.kg&fp=randomized&type=ws&host=mmx.vpnoir9r.us.kg&path=%2FCONTABO-SG#Contabo+GmbH+(SG)")'><i class="fa fa-clipboard"></i>Copy</button>
            </div>
            <hr />
            <div class="config-block">
                <h3>NTLS:</h3>
                <p class="config">vless://<a href="/cdn-cgi/l/email-protection" class="__cf_email__" data-cfemail="aa9b9e9bcecbc8cccf8798ce989e879e9c9b928793c9cfcc879c9398999d9bc892c8cb9ccbeac7c7d284dcdac4c5c3d893d884dfd984c1cd">[email&#160;protected]</a>:80?path=%2FCONTABO-SG&security=none&encryption=none&host=mmx.vpnoir9r.us.kg&fp=randomized&type=ws&sni=mmx.vpnoir9r.us.kg#Contabo+GmbH+(SG)</p>
                <button class="button" onclick='copyToClipboard("vless://141dabfe-2d24-4618-9cef-692371b8ba6a@mmx.vpnoir9r.us.kg:80?path=%2FCONTABO-SG&security=none&encryption=none&host=mmx.vpnoir9r.us.kg&fp=randomized&type=ws&sni=mmx.vpnoir9r.us.kg#Contabo+GmbH+(SG)")'><i class="fa fa-clipboard"></i>Copy</button>
            </div>
            <hr />
        </div>
    </div>
</div>
<hr class="config-divider" />
<div class="config-section">
    <p><strong>ISP  :  Alibaba (US) Technology Co., Ltd. (SG) </strong> </p>
    <hr />
    <div class="config-toggle">
        <button class="button" onclick="toggleConfig(this, 'show vless', 'hide vless')">Show Vless</button>
        <div class="config-content">
            <div class="config-block">
                <h3>TLS:</h3>
                <p class="config">vless://<a href="/cdn-cgi/l/email-protection" class="__cf_email__" data-cfemail="d5e2b1e3b3e7b0b4e1f8e1edb0ecf8e1b3e6e4f8b4b4e5ecf8e1e7e3e2e5e5b3b0e0b0e1b695b8b8adfba3a5bbbabca7eca7fba0a6fbbeb2">[email&#160;protected]</a>:443?encryption=none&security=tls&sni=mmx.vpnoir9r.us.kg&fp=randomized&type=ws&host=mmx.vpnoir9r.us.kg&path=%2Fsgalibaba#Alibaba+(US)+Technology+Co.,+Ltd.+(SG)</p>
                <button class="button" onclick='copyToClipboard("vless://7d6f2ea4-48e9-4f31-aa09-426700fe5e4c@mmx.vpnoir9r.us.kg:443?encryption=none&security=tls&sni=mmx.vpnoir9r.us.kg&fp=randomized&type=ws&host=mmx.vpnoir9r.us.kg&path=%2Fsgalibaba#Alibaba+(US)+Technology+Co.,+Ltd.+(SG)")'><i class="fa fa-clipboard"></i>Copy</button>
            </div>
            <hr />
            <div class="config-block">
                <h3>NTLS:</h3>
                <p class="config">vless://<a href="/cdn-cgi/l/email-protection" class="__cf_email__" data-cfemail="7047434816454647495d114443125d444645125d124045435d404048464413114412451344301d1d085e06001e1f190249025e05035e1b17">[email&#160;protected]</a>:80?path=%2Fsgalibaba&security=none&encryption=none&host=mmx.vpnoir9r.us.kg&fp=randomized&type=ws&sni=mmx.vpnoir9r.us.kg#Alibaba+(US)+Technology+Co.,+Ltd.+(SG)</p>
                <button class="button" onclick='copyToClipboard("vless://738f5679-a43b-465b-b053-00864ca4b5c4@mmx.vpnoir9r.us.kg:80?path=%2Fsgalibaba&security=none&encryption=none&host=mmx.vpnoir9r.us.kg&fp=randomized&type=ws&sni=mmx.vpnoir9r.us.kg#Alibaba+(US)+Technology+Co.,+Ltd.+(SG)")'><i class="fa fa-clipboard"></i>Copy</button>
            </div>
            <hr />
        </div>
    </div>
</div>
<hr class="config-divider" />
<div class="config-section">
    <p><strong>ISP  :  Akamai Technologies, Inc. (SG) </strong> </p>
    <hr />
    <div class="config-toggle">
        <button class="button" onclick="toggleConfig(this, 'show vless', 'hide vless')">Show Vless</button>
        <div class="config-content">
            <div class="config-block">
                <h3>TLS:</h3>
                <p class="config">vless://<a href="/cdn-cgi/l/email-protection" class="__cf_email__" data-cfemail="9fa7aeadaaf9a9abafb2adfafaacb2ababaafab2a6fbfbacb2affcabacf9a8aaacfafdf9acdff2f2e7b1e9eff1f0f6eda6edb1eaecb1f4f8">[email&#160;protected]</a>:443?encryption=none&security=tls&sni=mmx.vpnoir9r.us.kg&fp=randomized&type=ws&host=mmx.vpnoir9r.us.kg&path=%2Fsgakamai#Akamai+Technologies,+Inc.+(SG)</p>
                <button class="button" onclick='copyToClipboard("vless://8125f640-2ee3-445e-9dd3-0c43f753ebf3@mmx.vpnoir9r.us.kg:443?encryption=none&security=tls&sni=mmx.vpnoir9r.us.kg&fp=randomized&type=ws&host=mmx.vpnoir9r.us.kg&path=%2Fsgakamai#Akamai+Technologies,+Inc.+(SG)")'><i class="fa fa-clipboard"></i>Copy</button>
            </div>
            <hr />
            <div class="config-block">
                <h3>NTLS:</h3>
                <p class="config">vless://<a href="/cdn-cgi/l/email-protection" class="__cf_email__" data-cfemail="97f6a0f6f6a6a5a4f6baf3a3a7aebaa3f3a4f6baafa6afafbaa6a6a0a6f3afa4a6f4f5a4f2d7fafaefb9e1e7f9f8fee5aee5b9e2e4b9fcf0">[email&#160;protected]</a>:80?path=%2Fsgakamai&security=none&encryption=none&host=mmx.vpnoir9r.us.kg&fp=randomized&type=ws&sni=mmx.vpnoir9r.us.kg#Akamai+Technologies,+Inc.+(SG)</p>
                <button class="button" onclick='copyToClipboard("vless://a7aa123a-d409-4d3a-8188-1171d831cb3e@mmx.vpnoir9r.us.kg:80?path=%2Fsgakamai&security=none&encryption=none&host=mmx.vpnoir9r.us.kg&fp=randomized&type=ws&sni=mmx.vpnoir9r.us.kg#Akamai+Technologies,+Inc.+(SG)")'><i class="fa fa-clipboard"></i>Copy</button>
            </div>
            <hr />
        </div>
    </div>
</div>
<hr class="config-divider" />
<div class="config-section">
    <p><strong>ISP  :  Akamai Technologies, Inc. (ID) </strong> </p>
    <hr />
    <div class="config-toggle">
        <button class="button" onclick="toggleConfig(this, 'show vless', 'hide vless')">Show Vless</button>
        <div class="config-content">
            <div class="config-block">
                <h3>TLS:</h3>
                <p class="config">vless://<a href="/cdn-cgi/l/email-protection" class="__cf_email__" data-cfemail="af9dcdc99fcd9d9d9c82cc9fcd9f829b98cd968297cccaca829cc9989b989699cb979a98caefc2c2d781d9dfc1c0c6dd96dd81dadc81c4c8">[email&#160;protected]</a>:443?encryption=none&security=tls&sni=mmx.vpnoir9r.us.kg&fp=randomized&type=ws&host=mmx.vpnoir9r.us.kg&path=%2Fidakamai#Akamai+Technologies,+Inc.+(ID)</p>
                <button class="button" onclick='copyToClipboard("vless://2bf0b223-c0b0-47b9-8cee-3f74796d857e@mmx.vpnoir9r.us.kg:443?encryption=none&security=tls&sni=mmx.vpnoir9r.us.kg&fp=randomized&type=ws&host=mmx.vpnoir9r.us.kg&path=%2Fidakamai#Akamai+Technologies,+Inc.+(ID)")'><i class="fa fa-clipboard"></i>Copy</button>
            </div>
            <hr />
            <div class="config-block">
                <h3>NTLS:</h3>
                <p class="config">vless://<a href="/cdn-cgi/l/email-protection" class="__cf_email__" data-cfemail="cffff8faaaf7fefaf9e2aaf9fbfde2fbf9f7f7e2adfdfefbe2ffabaea9f7fff8fcf6f6fbae8fa2a2b7e1b9bfa1a0a6bdf6bde1babce1a4a8">[email&#160;protected]</a>:80?path=%2Fidakamai&security=none&encryption=none&host=mmx.vpnoir9r.us.kg&fp=randomized&type=ws&sni=mmx.vpnoir9r.us.kg#Akamai+Technologies,+Inc.+(ID)</p>
                <button class="button" onclick='copyToClipboard("vless://075e8156-e642-4688-b214-0daf8073994a@mmx.vpnoir9r.us.kg:80?path=%2Fidakamai&security=none&encryption=none&host=mmx.vpnoir9r.us.kg&fp=randomized&type=ws&sni=mmx.vpnoir9r.us.kg#Akamai+Technologies,+Inc.+(ID)")'><i class="fa fa-clipboard"></i>Copy</button>
            </div>
            <hr />
        </div>
    </div>
</div>
<hr class="config-divider" />
<div class="config-section">
    <p><strong>ISP  :  Hetzner Online GmbH (SG) </strong> </p>
    <hr />
    <div class="config-toggle">
        <button class="button" onclick="toggleConfig(this, 'show vless', 'hide vless')">Show Vless</button>
        <div class="config-content">
            <div class="config-block">
                <h3>TLS:</h3>
                <p class="config">vless://<a href="/cdn-cgi/l/email-protection" class="__cf_email__" data-cfemail="e3d7dbda8086d4d7dbced482d3d0ced781d3dbcedbd08082ced185d181d186d5d3d1d2da81a38e8e9bcd95938d8c8a91da91cd9690cd8884">[email&#160;protected]</a>:443?encryption=none&security=tls&sni=mmx.vpnoir9r.us.kg&fp=randomized&type=ws&host=mmx.vpnoir9r.us.kg&path=%2Fsghz#Hetzner+Online+GmbH+(SG)</p>
                <button class="button" onclick='copyToClipboard("vless://489ce748-7a03-4b08-83ca-2f2b2e60219b@mmx.vpnoir9r.us.kg:443?encryption=none&security=tls&sni=mmx.vpnoir9r.us.kg&fp=randomized&type=ws&host=mmx.vpnoir9r.us.kg&path=%2Fsghz#Hetzner+Online+GmbH+(SG)")'><i class="fa fa-clipboard"></i>Copy</button>
            </div>
            <hr />
            <div class="config-block">
                <h3>NTLS:</h3>
                <p class="config">vless://<a href="/cdn-cgi/l/email-protection" class="__cf_email__" data-cfemail="2e1c4b1f1e1a4f1e1a031c1e4a1d031a4c1f1f03164f1d1c034a4d4d4f4b1c184a1b4d1b4c6e43435600585e4041475c175c005b5d004549">[email&#160;protected]</a>:80?path=%2Fsghz&security=none&encryption=none&host=mmx.vpnoir9r.us.kg&fp=randomized&type=ws&sni=mmx.vpnoir9r.us.kg#Hetzner+Online+GmbH+(SG)</p>
                <button class="button" onclick='copyToClipboard("vless://2e104a04-20d3-4b11-8a32-dccae26d5c5b@mmx.vpnoir9r.us.kg:80?path=%2Fsghz&security=none&encryption=none&host=mmx.vpnoir9r.us.kg&fp=randomized&type=ws&sni=mmx.vpnoir9r.us.kg#Hetzner+Online+GmbH+(SG)")'><i class="fa fa-clipboard"></i>Copy</button>
            </div>
            <hr />
        </div>
    </div>
</div>
<hr class="config-divider" />
<div class="config-section">
    <p><strong>ISP  :  Google LLC (ID) </strong> </p>
    <hr />
    <div class="config-toggle">
        <button class="button" onclick="toggleConfig(this, 'show vless', 'hide vless')">Show Vless</button>
        <div class="config-content">
            <div class="config-block">
                <h3>TLS:</h3>
                <p class="config">vless://<a href="/cdn-cgi/l/email-protection" class="__cf_email__" data-cfemail="0d6b3e6f3c6e343d382038683c6c2039356e6b20346e386e203d6e356c3a3b6c3c3b6e3d694d606075237b7d6362647f347f23787e23666a">[email&#160;protected]</a>:443?encryption=none&security=tls&sni=mmx.vpnoir9r.us.kg&fp=randomized&type=ws&host=mmx.vpnoir9r.us.kg&path=%2FGCPID#Google+LLC+(ID)</p>
                <button class="button" onclick='copyToClipboard("vless://f3b1c905-5e1a-48cf-9c5c-0c8a76a16c0d@mmx.vpnoir9r.us.kg:443?encryption=none&security=tls&sni=mmx.vpnoir9r.us.kg&fp=randomized&type=ws&host=mmx.vpnoir9r.us.kg&path=%2FGCPID#Google+LLC+(ID)")'><i class="fa fa-clipboard"></i>Copy</button>
            </div>
            <hr />
            <div class="config-block">
                <h3>NTLS:</h3>
                <p class="config">vless://<a href="/cdn-cgi/l/email-protection" class="__cf_email__" data-cfemail="89bdeaecbbecb9bdefa4bbedeab9a4bdb8ede8a4ebbabdb1a4b8b9edbdb9b9ecbbb8b8bfedc9e4e4f1a7fff9e7e6e0fbb0fba7fcfaa7e2ee">[email&#160;protected]</a>:80?path=%2FGCPID&security=none&encryption=none&host=mmx.vpnoir9r.us.kg&fp=randomized&type=ws&sni=mmx.vpnoir9r.us.kg#Google+LLC+(ID)</p>
                <button class="button" onclick='copyToClipboard("vless://4ce2e04f-2dc0-41da-b348-10d400e2116d@mmx.vpnoir9r.us.kg:80?path=%2FGCPID&security=none&encryption=none&host=mmx.vpnoir9r.us.kg&fp=randomized&type=ws&sni=mmx.vpnoir9r.us.kg#Google+LLC+(ID)")'><i class="fa fa-clipboard"></i>Copy</button>
            </div>
            <hr />
        </div>
    </div>
</div>
<hr class="config-divider" />
<div class="config-section">
    <p><strong>ISP  :  ADSL Streamyx Telekom Malaysia (MY) </strong> </p>
    <hr />
    <div class="config-toggle">
        <button class="button" onclick="toggleConfig(this, 'show vless', 'hide vless')">Show Vless</button>
        <div class="config-content">
            <div class="config-block">
                <h3>TLS:</h3>
                <p class="config">vless://<a href="/cdn-cgi/l/email-protection" class="__cf_email__" data-cfemail="e2d6dad58684d6d1d1cfd68186d0cfd6d2d786cfda83d2d7cfd7d4d0d7d2d683d6d383d2d7a28f8f9acc94928c8d8b90db90cc9791cc8985">[email&#160;protected]</a>:443?encryption=none&security=tls&sni=mmx.vpnoir9r.us.kg&fp=randomized&type=ws&host=mmx.vpnoir9r.us.kg&path=%2Fmy2#ADSL+Streamyx+Telekom+Malaysia+(MY)</p>
                <button class="button" onclick='copyToClipboard("vless://487df433-4cd2-405d-8a05-562504a41a05@mmx.vpnoir9r.us.kg:443?encryption=none&security=tls&sni=mmx.vpnoir9r.us.kg&fp=randomized&type=ws&host=mmx.vpnoir9r.us.kg&path=%2Fmy2#ADSL+Streamyx+Telekom+Malaysia+(MY)")'><i class="fa fa-clipboard"></i>Copy</button>
            </div>
            <hr />
            <div class="config-block">
                <h3>NTLS:</h3>
                <p class="config">vless://<a href="/cdn-cgi/l/email-protection" class="__cf_email__" data-cfemail="5d6b6c6f6d6b3b6f6b70656b383f70696b683870643f646a70656939386c3b3b643965646d1d303025732b2d3332342f642f73282e73363a">[email&#160;protected]</a>:80?path=%2Fmy2&security=none&encryption=none&host=mmx.vpnoir9r.us.kg&fp=randomized&type=ws&sni=mmx.vpnoir9r.us.kg#ADSL+Streamyx+Telekom+Malaysia+(MY)</p>
                <button class="button" onclick='copyToClipboard("vless://61206f26-86eb-465e-9b97-84de1ff9d890@mmx.vpnoir9r.us.kg:80?path=%2Fmy2&security=none&encryption=none&host=mmx.vpnoir9r.us.kg&fp=randomized&type=ws&sni=mmx.vpnoir9r.us.kg#ADSL+Streamyx+Telekom+Malaysia+(MY)")'><i class="fa fa-clipboard"></i>Copy</button>
            </div>
            <hr />
        </div>
    </div>
</div>
<hr class="config-divider" />
<div class="config-section">
    <p><strong>ISP  :  Capitalonline Data Service (HK) Co (SG) </strong> </p>
    <hr />
    <div class="config-toggle">
        <button class="button" onclick="toggleConfig(this, 'show vless', 'hide vless')">Show Vless</button>
        <div class="config-content">
            <div class="config-block">
                <h3>TLS:</h3>
                <p class="config">vless://<a href="/cdn-cgi/l/email-protection" class="__cf_email__" data-cfemail="42752320717a7276766f27737a216f762175276f20717a706f2074212671247b7620707675022f2f3a6c34322c2d2b307b306c37316c2925">[email&#160;protected]</a>:443?encryption=none&security=tls&sni=mmx.vpnoir9r.us.kg&fp=randomized&type=ws&host=mmx.vpnoir9r.us.kg&path=%2FCDSGLOBALSG#Capitalonline+Data+Service+(HK)+Co+(SG)</p>
                <button class="button" onclick='copyToClipboard("vless://7ab38044-e18c-4c7e-b382-b6cd3f94b247@mmx.vpnoir9r.us.kg:443?encryption=none&security=tls&sni=mmx.vpnoir9r.us.kg&fp=randomized&type=ws&host=mmx.vpnoir9r.us.kg&path=%2FCDSGLOBALSG#Capitalonline+Data+Service+(HK)+Co+(SG)")'><i class="fa fa-clipboard"></i>Copy</button>
            </div>
            <hr />
            <div class="config-block">
                <h3>NTLS:</h3>
                <p class="config">vless://<a href="/cdn-cgi/l/email-protection" class="__cf_email__" data-cfemail="6a525e090b5a5d5f5b470c0b530c475e595c0f4753585353475b0c5c080b0c0f585e59595e2a070712441c1a040503185318441f1944010d">[email&#160;protected]</a>:80?path=%2FCDSGLOBALSG&security=none&encryption=none&host=mmx.vpnoir9r.us.kg&fp=randomized&type=ws&sni=mmx.vpnoir9r.us.kg#Capitalonline+Data+Service+(HK)+Co+(SG)</p>
                <button class="button" onclick='copyToClipboard("vless://84ca0751-fa9f-436e-9299-1f6bafe24334@mmx.vpnoir9r.us.kg:80?path=%2FCDSGLOBALSG&security=none&encryption=none&host=mmx.vpnoir9r.us.kg&fp=randomized&type=ws&sni=mmx.vpnoir9r.us.kg#Capitalonline+Data+Service+(HK)+Co+(SG)")'><i class="fa fa-clipboard"></i>Copy</button>
            </div>
            <hr />
        </div>
    </div>
</div>
<hr class="config-divider" />
<div class="config-section">
    <p><strong>ISP  :  OVH SAS (SG) </strong> </p>
    <hr />
    <div class="config-toggle">
        <button class="button" onclick="toggleConfig(this, 'show vless', 'hide vless')">Show Vless</button>
        <div class="config-content">
            <div class="config-block">
                <h3>TLS:</h3>
                <p class="config">vless://<a href="/cdn-cgi/l/email-protection" class="__cf_email__" data-cfemail="3b0e080e0c590e020b165f03030a160f020d0b165a5d5809160309025d58030b5e0a0c090f7b565643154d4b555452490249154e4815505c">[email&#160;protected]</a>:443?encryption=none&security=tls&sni=mmx.vpnoir9r.us.kg&fp=randomized&type=ws&host=mmx.vpnoir9r.us.kg&path=%2Fsgovhsas#OVH+SAS+(SG)</p>
                <button class="button" onclick='copyToClipboard("vless://5357b590-d881-4960-afc2-829fc80e1724@mmx.vpnoir9r.us.kg:443?encryption=none&security=tls&sni=mmx.vpnoir9r.us.kg&fp=randomized&type=ws&host=mmx.vpnoir9r.us.kg&path=%2Fsgovhsas#OVH+SAS+(SG)")'><i class="fa fa-clipboard"></i>Copy</button>
            </div>
            <hr />
            <div class="config-block">
                <h3>NTLS:</h3>
                <p class="config">vless://<a href="/cdn-cgi/l/email-protection" class="__cf_email__" data-cfemail="5137656766356835627c616430377c653263687c696232697c623333676266626768673067113c3c297f27213f3e382368237f24227f3a36">[email&#160;protected]</a>:80?path=%2Fsgovhsas&security=none&encryption=none&host=mmx.vpnoir9r.us.kg&fp=randomized&type=ws&sni=mmx.vpnoir9r.us.kg#OVH+SAS+(SG)</p>
                <button class="button" onclick='copyToClipboard("vless://f467d9d3-05af-4c29-83c8-3bb6373696a6@mmx.vpnoir9r.us.kg:80?path=%2Fsgovhsas&security=none&encryption=none&host=mmx.vpnoir9r.us.kg&fp=randomized&type=ws&sni=mmx.vpnoir9r.us.kg#OVH+SAS+(SG)")'><i class="fa fa-clipboard"></i>Copy</button>
            </div>
            <hr />
        </div>
    </div>
</div>
<hr class="config-divider" />
<div class="config-section">
    <p><strong>ISP  :  DigitalOcean, LLC (SG) </strong> </p>
    <hr />
    <div class="config-toggle">
        <button class="button" onclick="toggleConfig(this, 'show vless', 'hide vless')">Show Vless</button>
        <div class="config-content">
            <div class="config-block">
                <h3>TLS:</h3>
                <p class="config">vless://<a href="/cdn-cgi/l/email-protection" class="__cf_email__" data-cfemail="395a0a580a0b010f0b145b0c0e00140d090d0814585a005a14095c0e01085a0d0a0b5f005879545441174f495756504b004b174c4a17525e">[email&#160;protected]</a>:443?encryption=none&security=tls&sni=mmx.vpnoir9r.us.kg&fp=randomized&type=ws&host=mmx.vpnoir9r.us.kg&path=%2Fsgdo#DigitalOcean,+LLC+(SG)</p>
                <button class="button" onclick='copyToClipboard("vless://c3a32862-b579-4041-ac9c-0e781c432f9a@mmx.vpnoir9r.us.kg:443?encryption=none&security=tls&sni=mmx.vpnoir9r.us.kg&fp=randomized&type=ws&host=mmx.vpnoir9r.us.kg&path=%2Fsgdo#DigitalOcean,+LLC+(SG)")'><i class="fa fa-clipboard"></i>Copy</button>
            </div>
            <hr />
            <div class="config-block">
                <h3>NTLS:</h3>
                <p class="config">vless://<a href="/cdn-cgi/l/email-protection" class="__cf_email__" data-cfemail="6059045256500606514d570459524d545101064d580453584d555905590558060102035159200d0d184e16100e0f091259124e15134e0b07">[email&#160;protected]</a>:80?path=%2Fsgdo&security=none&encryption=none&host=mmx.vpnoir9r.us.kg&fp=randomized&type=ws&sni=mmx.vpnoir9r.us.kg#DigitalOcean,+LLC+(SG)</p>
                <button class="button" onclick='copyToClipboard("vless://9d260ff1-7d92-41af-8d38-59e9e8fabc19@mmx.vpnoir9r.us.kg:80?path=%2Fsgdo&security=none&encryption=none&host=mmx.vpnoir9r.us.kg&fp=randomized&type=ws&sni=mmx.vpnoir9r.us.kg#DigitalOcean,+LLC+(SG)")'><i class="fa fa-clipboard"></i>Copy</button>
            </div>
            <hr />
        </div>
    </div>
</div>
<hr class="config-divider" />
<div class="config-section">
    <p><strong>ISP  :  NPO G-net (SG) </strong> </p>
    <hr />
    <div class="config-toggle">
        <button class="button" onclick="toggleConfig(this, 'show vless', 'hide vless')">Show Vless</button>
        <div class="config-content">
            <div class="config-block">
                <h3>TLS:</h3>
                <p class="config">vless://<a href="/cdn-cgi/l/email-protection" class="__cf_email__" data-cfemail="5662306360606f37647b343060677b623335637b376532337b333033676737606f64653560163b3b2e78202638393f246f24782325783d31">[email&#160;protected]</a>:443?encryption=none&security=tls&sni=mmx.vpnoir9r.us.kg&fp=randomized&type=ws&host=mmx.vpnoir9r.us.kg&path=%2Fsgnpo#NPO+G-net+(SG)</p>
                <button class="button" onclick='copyToClipboard("vless://4f5669a2-bf61-4ec5-a3de-efe11a6923c6@mmx.vpnoir9r.us.kg:443?encryption=none&security=tls&sni=mmx.vpnoir9r.us.kg&fp=randomized&type=ws&host=mmx.vpnoir9r.us.kg&path=%2Fsgnpo#NPO+G-net+(SG)")'><i class="fa fa-clipboard"></i>Copy</button>
            </div>
            <hr />
            <div class="config-block">
                <h3>NTLS:</h3>
                <p class="config">vless://<a href="/cdn-cgi/l/email-protection" class="__cf_email__" data-cfemail="dabbeab8e9eabfedbbf7bce2ebb9f7eeecedb8f7bbe2e8bbf7eeeceeedbbebeeefeeebbfbc9ab7b7a2f4acaab4b5b3a8e3a8f4afa9f4b1bd">[email&#160;protected]</a>:80?path=%2Fsgnpo&security=none&encryption=none&host=mmx.vpnoir9r.us.kg&fp=randomized&type=ws&sni=mmx.vpnoir9r.us.kg#NPO+G-net+(SG)</p>
                <button class="button" onclick='copyToClipboard("vless://a0b30e7a-f81c-467b-a82a-4647a14541ef@mmx.vpnoir9r.us.kg:80?path=%2Fsgnpo&security=none&encryption=none&host=mmx.vpnoir9r.us.kg&fp=randomized&type=ws&sni=mmx.vpnoir9r.us.kg#NPO+G-net+(SG)")'><i class="fa fa-clipboard"></i>Copy</button>
            </div>
            <hr />
        </div>
    </div>
</div>
<hr class="config-divider" />
<div class="config-section">
    <p><strong>ISP  :  HONG KONG Megalayer Technology Co., Limited (SG) </strong> </p>
    <hr />
    <div class="config-toggle">
        <button class="button" onclick="toggleConfig(this, 'show vless', 'hide vless')">Show Vless</button>
        <div class="config-content">
            <div class="config-block">
                <h3>TLS:</h3>
                <p class="config">vless://<a href="/cdn-cgi/l/email-protection" class="__cf_email__" data-cfemail="f193c09097c89494c4dcc09795c1dcc593c3c3dc90c9c694dc92c690c7c49490c1c694c0c4b19c9c89df87819f9e9883c883df8482df9a96">[email&#160;protected]</a>:443?encryption=none&security=tls&sni=mmx.vpnoir9r.us.kg&fp=randomized&type=ws&host=mmx.vpnoir9r.us.kg&path=%2Fsgmegalayer#HONG+KONG+Megalayer+Technology+Co.,+Limited+(SG)</p>
                <button class="button" onclick='copyToClipboard("vless://b1af9ee5-1fd0-4b22-a87e-c7a65ea07e15@mmx.vpnoir9r.us.kg:443?encryption=none&security=tls&sni=mmx.vpnoir9r.us.kg&fp=randomized&type=ws&host=mmx.vpnoir9r.us.kg&path=%2Fsgmegalayer#HONG+KONG+Megalayer+Technology+Co.,+Limited+(SG)")'><i class="fa fa-clipboard"></i>Copy</button>
            </div>
            <hr />
            <div class="config-block">
                <h3>NTLS:</h3>
                <p class="config">vless://<a href="/cdn-cgi/l/email-protection" class="__cf_email__" data-cfemail="80b4e4b5e5e4b7b2b8adb4b0b4b5adb4b2b2e2ade1b1b3e5ade1b9b2b2b1b6b8b4b1b5e4e6c0ededf8aef6f0eeefe9f2b9f2aef5f3aeebe7">[email&#160;protected]</a>:80?path=%2Fsgmegalayer&security=none&encryption=none&host=mmx.vpnoir9r.us.kg&fp=randomized&type=ws&sni=mmx.vpnoir9r.us.kg#HONG+KONG+Megalayer+Technology+Co.,+Limited+(SG)</p>
                <button class="button" onclick='copyToClipboard("vless://4d5ed728-4045-422b-a13e-a922168415df@mmx.vpnoir9r.us.kg:80?path=%2Fsgmegalayer&security=none&encryption=none&host=mmx.vpnoir9r.us.kg&fp=randomized&type=ws&sni=mmx.vpnoir9r.us.kg#HONG+KONG+Megalayer+Technology+Co.,+Limited+(SG)")'><i class="fa fa-clipboard"></i>Copy</button>
            </div>
            <hr />
        </div>
    </div>
</div>
<hr class="config-divider" />
<div class="config-section">
    <p><strong>ISP  :  Oracle Corporation (SG) </strong> </p>
    <hr />
    <div class="config-toggle">
        <button class="button" onclick="toggleConfig(this, 'show vless', 'hide vless')">Show Vless</button>
        <div class="config-content">
            <div class="config-block">
                <h3>TLS:</h3>
                <p class="config">vless://<a href="/cdn-cgi/l/email-protection" class="__cf_email__" data-cfemail="3152075704015250031c070005531c050652501c090355551c030502080850015455050753715c5c491f47415f5e584308431f44421f5a56">[email&#160;protected]</a>:443?encryption=none&security=tls&sni=mmx.vpnoir9r.us.kg&fp=randomized&type=ws&host=mmx.vpnoir9r.us.kg&path=%2Fsgoracle#Oracle+Corporation+(SG)</p>
                <button class="button" onclick='copyToClipboard("vless://c6f50ca2-614b-47ca-82dd-24399a0ed46b@mmx.vpnoir9r.us.kg:443?encryption=none&security=tls&sni=mmx.vpnoir9r.us.kg&fp=randomized&type=ws&host=mmx.vpnoir9r.us.kg&path=%2Fsgoracle#Oracle+Corporation+(SG)")'><i class="fa fa-clipboard"></i>Copy</button>
            </div>
            <hr />
            <div class="config-block">
                <h3>NTLS:</h3>
                <p class="config">vless://<a href="/cdn-cgi/l/email-protection" class="__cf_email__" data-cfemail="c0a5a6f1f5f2a2f0f6eda4f6f2a5edf4f0f4a2edf9f6a6f8edf9f7a4f7f7f1f2f7f4a2a3a580adadb8eeb6b0aeafa9b2f9b2eeb5b3eeaba7">[email&#160;protected]</a>:80?path=%2Fsgoracle&security=none&encryption=none&host=mmx.vpnoir9r.us.kg&fp=randomized&type=ws&sni=mmx.vpnoir9r.us.kg#Oracle+Corporation+(SG)</p>
                <button class="button" onclick='copyToClipboard("vless://ef152b06-d62e-404b-96f8-97d771274bce@mmx.vpnoir9r.us.kg:80?path=%2Fsgoracle&security=none&encryption=none&host=mmx.vpnoir9r.us.kg&fp=randomized&type=ws&sni=mmx.vpnoir9r.us.kg#Oracle+Corporation+(SG)")'><i class="fa fa-clipboard"></i>Copy</button>
            </div>
            <hr />
        </div>
    </div>
</div>
<hr class="config-divider" />
<div class="config-section">
    <p><strong>ISP  :  Aryaka Networks, Inc. (SG) </strong> </p>
    <hr />
    <div class="config-toggle">
        <button class="button" onclick="toggleConfig(this, 'show vless', 'hide vless')">Show Vless</button>
        <div class="config-content">
            <div class="config-block">
                <h3>TLS:</h3>
                <p class="config">vless://<a href="/cdn-cgi/l/email-protection" class="__cf_email__" data-cfemail="6453510101065305054905005005495054545c49055d5c55490005060100540154010605542409091c4a12140a0b0d165d164a11174a0f03">[email&#160;protected]</a>:443?encryption=none&security=tls&sni=mmx.vpnoir9r.us.kg&fp=randomized&type=ws&host=mmx.vpnoir9r.us.kg&path=%2Fsgaryaka#Aryaka+Networks,+Inc.+(SG)</p>
                <button class="button" onclick='copyToClipboard("vless://75eeb7aa-ad4a-4008-a981-dabed0e0eba0@mmx.vpnoir9r.us.kg:443?encryption=none&security=tls&sni=mmx.vpnoir9r.us.kg&fp=randomized&type=ws&host=mmx.vpnoir9r.us.kg&path=%2Fsgaryaka#Aryaka+Networks,+Inc.+(SG)")'><i class="fa fa-clipboard"></i>Copy</button>
            </div>
            <hr />
            <div class="config-block">
                <h3>NTLS:</h3>
                <p class="config">vless://<a href="/cdn-cgi/l/email-protection" class="__cf_email__" data-cfemail="87b1b4e1b4b6b0b0b3aae3e5b7b5aab3e6bebeaabfbebfe2aab3e6b4bee2e2e1e2b4b3b5b2c7eaeaffa9f1f7e9e8eef5bef5a9f2f4a9ece0">[email&#160;protected]</a>:80?path=%2Fsgaryaka&security=none&encryption=none&host=mmx.vpnoir9r.us.kg&fp=randomized&type=ws&sni=mmx.vpnoir9r.us.kg#Aryaka+Networks,+Inc.+(SG)</p>
                <button class="button" onclick='copyToClipboard("vless://63f31774-db02-4a99-898e-4a39eefe3425@mmx.vpnoir9r.us.kg:80?path=%2Fsgaryaka&security=none&encryption=none&host=mmx.vpnoir9r.us.kg&fp=randomized&type=ws&sni=mmx.vpnoir9r.us.kg#Aryaka+Networks,+Inc.+(SG)")'><i class="fa fa-clipboard"></i>Copy</button>
            </div>
            <hr />
        </div>
    </div>
</div>
<hr class="config-divider" />
<div class="config-section">
    <p><strong>ISP  :  First Server Limited (SG) </strong> </p>
    <hr />
    <div class="config-toggle">
        <button class="button" onclick="toggleConfig(this, 'show vless', 'hide vless')">Show Vless</button>
        <div class="config-content">
            <div class="config-block">
                <h3>TLS:</h3>
                <p class="config">vless://<a href="/cdn-cgi/l/email-protection" class="__cf_email__" data-cfemail="7d184c4f1f4a1f491c50194a4a485049494f4f504544181b504e4d4c4545184b4c4f1b4b443d101005530b0d1312140f440f53080e53161a">[email&#160;protected]</a>:443?encryption=none&security=tls&sni=mmx.vpnoir9r.us.kg&fp=randomized&type=ws&host=mmx.vpnoir9r.us.kg&path=%2Fsgbelnet#First+Server+Limited+(SG)</p>
                <button class="button" onclick='copyToClipboard("vless://e12b7b4a-d775-4422-89ef-30188e612f69@mmx.vpnoir9r.us.kg:443?encryption=none&security=tls&sni=mmx.vpnoir9r.us.kg&fp=randomized&type=ws&host=mmx.vpnoir9r.us.kg&path=%2Fsgbelnet#First+Server+Limited+(SG)")'><i class="fa fa-clipboard"></i>Copy</button>
            </div>
            <hr />
            <div class="config-block">
                <h3>NTLS:</h3>
                <p class="config">vless://<a href="/cdn-cgi/l/email-protection" class="__cf_email__" data-cfemail="80b1e4e2b4b9b2b4b4adb4b3b1e1adb4b7b1b2ade2b4b7b8adb1b3e6e6b6e2b8b9e4b6e2e6c0ededf8aef6f0eeefe9f2b9f2aef5f3aeebe7">[email&#160;protected]</a>:80?path=%2Fsgbelnet&security=none&encryption=none&host=mmx.vpnoir9r.us.kg&fp=randomized&type=ws&sni=mmx.vpnoir9r.us.kg#First+Server+Limited+(SG)</p>
                <button class="button" onclick='copyToClipboard("vless://1db49244-431a-4712-b478-13ff6b89d6bf@mmx.vpnoir9r.us.kg:80?path=%2Fsgbelnet&security=none&encryption=none&host=mmx.vpnoir9r.us.kg&fp=randomized&type=ws&sni=mmx.vpnoir9r.us.kg#First+Server+Limited+(SG)")'><i class="fa fa-clipboard"></i>Copy</button>
            </div>
            <hr />
        </div>
    </div>
</div>
<hr class="config-divider" />
<div class="config-section">
    <p><strong>ISP  :  Amazon.com, Inc. (SG) </strong> </p>
    <hr />
    <div class="config-toggle">
        <button class="button" onclick="toggleConfig(this, 'show vless', 'hide vless')">Show Vless</button>
        <div class="config-content">
            <div class="config-block">
                <h3>TLS:</h3>
                <p class="config">vless://<a href="/cdn-cgi/l/email-protection" class="__cf_email__" data-cfemail="bd8d8a848b858d8c8f908fde8e8990898e8a899085dcdf8d90858a8b8cdc8b8cde88dc8edffdd0d0c593cbcdd3d2d4cf84cf93c8ce93d6da">[email&#160;protected]</a>:443?encryption=none&security=tls&sni=mmx.vpnoir9r.us.kg&fp=randomized&type=ws&host=mmx.vpnoir9r.us.kg&path=%2Fsgamazon#Amazon.com,+Inc.+(SG)</p>
                <button class="button" onclick='copyToClipboard("vless://07968012-2c34-4374-8ab0-8761a61c5a3b@mmx.vpnoir9r.us.kg:443?encryption=none&security=tls&sni=mmx.vpnoir9r.us.kg&fp=randomized&type=ws&host=mmx.vpnoir9r.us.kg&path=%2Fsgamazon#Amazon.com,+Inc.+(SG)")'><i class="fa fa-clipboard"></i>Copy</button>
            </div>
            <hr />
            <div class="config-block">
                <h3>NTLS:</h3>
                <p class="config">vless://<a href="/cdn-cgi/l/email-protection" class="__cf_email__" data-cfemail="96f3f0f3f5f5a3f3a7bba1f5f4a1bba2aff5f0bbaea0a4a4bba2f7f0f3f7f3a4f0aea2f2f4d6fbfbeeb8e0e6f8f9ffe4afe4b8e3e5b8fdf1">[email&#160;protected]</a>:80?path=%2Fsgamazon&security=none&encryption=none&host=mmx.vpnoir9r.us.kg&fp=randomized&type=ws&sni=mmx.vpnoir9r.us.kg#Amazon.com,+Inc.+(SG)</p>
                <button class="button" onclick='copyToClipboard("vless://efecc5e1-7cb7-49cf-8622-4afeae2f84db@mmx.vpnoir9r.us.kg:80?path=%2Fsgamazon&security=none&encryption=none&host=mmx.vpnoir9r.us.kg&fp=randomized&type=ws&sni=mmx.vpnoir9r.us.kg#Amazon.com,+Inc.+(SG)")'><i class="fa fa-clipboard"></i>Copy</button>
            </div>
            <hr />
        </div>
    </div>
</div>
<hr class="config-divider" />

        </div>
        <div id="clash" class="content">
            <div style="display: none;">
   <textarea id="clashTls/id-akm">- name: Akamai Technologies, Inc. (ID)
  server: mmx.vpnoir9r.us.kg
  port: 443
  type: vless
  uuid: abf272b5-a4cc-48b1-8d2b-b94ce61291dc
  cipher: auto
  tls: true
  udp: true
  skip-cert-verify: true
  network: ws
  servername: mmx.vpnoir9r.us.kg
  ws-opts:
    path: /id-akm
    headers:
      Host: mmx.vpnoir9r.us.kg</textarea>
 </div>
<div style="display: none;">
   <textarea id="clashNtls/id-akm">- name: Akamai Technologies, Inc. (ID)
  server: mmx.vpnoir9r.us.kg
  port: 80
  type: vless
  uuid: 31a18855-f07f-424d-8473-403c096379a2
  cipher: auto
  tls: false
  udp: true
  skip-cert-verify: true
  network: ws
  ws-opts:
    path: /id-akm
    headers:
      Host: mmx.vpnoir9r.us.kg</textarea>
 </div>
<div class="config-section">
    <p><strong>ISP  :  Akamai Technologies, Inc. (ID)</strong> </p>
    <hr/>
    <div class="config-toggle">
        <button class="button" onclick="toggleConfig(this, 'show clash', 'hide clash')">Show Clash</button>
        <div class="config-content">
            <div class="config-block">
                <h3>TLS:</h3>
                <p class="config">- name: Akamai Technologies, Inc. (ID)
  server: mmx.vpnoir9r.us.kg
  port: 443
  type: vless
  uuid: abf272b5-a4cc-48b1-8d2b-b94ce61291dc
  cipher: auto
  tls: true
  udp: true
  skip-cert-verify: true
  network: ws
  servername: mmx.vpnoir9r.us.kg
  ws-opts:
    path: /id-akm
    headers:
      Host: mmx.vpnoir9r.us.kg</p>
                <button class="button" onclick='copyClash("clashTls/id-akm")'><i class="fa fa-clipboard"></i>Copy</button>
            </div>
            <hr />
            <div class="config-block">
                <h3>NTLS:</h3>
                <p class="config">- name: Akamai Technologies, Inc. (ID)
  server: mmx.vpnoir9r.us.kg
  port: 80
  type: vless
  uuid: 31a18855-f07f-424d-8473-403c096379a2
  cipher: auto
  tls: false
  udp: true
  skip-cert-verify: true
  network: ws
  ws-opts:
    path: /id-akm
    headers:
      Host: mmx.vpnoir9r.us.kg</p>
                <button class="button" onclick='copyClash("clashNtls/id-akm")'><i class="fa fa-clipboard"></i>Copy</button>
            </div>
        </div>
    </div>
</div>
<hr class="config-divider" />
<div style="display: none;">
   <textarea id="clashTls/sg-byt">- name: ByteVirt LLC (SG)
  server: mmx.vpnoir9r.us.kg
  port: 443
  type: vless
  uuid: 27f4d87f-597a-4974-be46-0a68a3a8a449
  cipher: auto
  tls: true
  udp: true
  skip-cert-verify: true
  network: ws
  servername: mmx.vpnoir9r.us.kg
  ws-opts:
    path: /sg-byt
    headers:
      Host: mmx.vpnoir9r.us.kg</textarea>
 </div>
<div style="display: none;">
   <textarea id="clashNtls/sg-byt">- name: ByteVirt LLC (SG)
  server: mmx.vpnoir9r.us.kg
  port: 80
  type: vless
  uuid: 70c521b7-7d02-4225-a16c-70fcb8d967f8
  cipher: auto
  tls: false
  udp: true
  skip-cert-verify: true
  network: ws
  ws-opts:
    path: /sg-byt
    headers:
      Host: mmx.vpnoir9r.us.kg</textarea>
 </div>
<div class="config-section">
    <p><strong>ISP  :  ByteVirt LLC (SG)</strong> </p>
    <hr/>
    <div class="config-toggle">
        <button class="button" onclick="toggleConfig(this, 'show clash', 'hide clash')">Show Clash</button>
        <div class="config-content">
            <div class="config-block">
                <h3>TLS:</h3>
                <p class="config">- name: ByteVirt LLC (SG)
  server: mmx.vpnoir9r.us.kg
  port: 443
  type: vless
  uuid: 27f4d87f-597a-4974-be46-0a68a3a8a449
  cipher: auto
  tls: true
  udp: true
  skip-cert-verify: true
  network: ws
  servername: mmx.vpnoir9r.us.kg
  ws-opts:
    path: /sg-byt
    headers:
      Host: mmx.vpnoir9r.us.kg</p>
                <button class="button" onclick='copyClash("clashTls/sg-byt")'><i class="fa fa-clipboard"></i>Copy</button>
            </div>
            <hr />
            <div class="config-block">
                <h3>NTLS:</h3>
                <p class="config">- name: ByteVirt LLC (SG)
  server: mmx.vpnoir9r.us.kg
  port: 80
  type: vless
  uuid: 70c521b7-7d02-4225-a16c-70fcb8d967f8
  cipher: auto
  tls: false
  udp: true
  skip-cert-verify: true
  network: ws
  ws-opts:
    path: /sg-byt
    headers:
      Host: mmx.vpnoir9r.us.kg</p>
                <button class="button" onclick='copyClash("clashNtls/sg-byt")'><i class="fa fa-clipboard"></i>Copy</button>
            </div>
        </div>
    </div>
</div>
<hr class="config-divider" />
<div style="display: none;">
   <textarea id="clashTls/id-tsel">- name: Telekomunikasi Indonesia (ID)
  server: mmx.vpnoir9r.us.kg
  port: 443
  type: vless
  uuid: f2d58d9b-74ff-45ea-931d-7dcb3516aff4
  cipher: auto
  tls: true
  udp: true
  skip-cert-verify: true
  network: ws
  servername: mmx.vpnoir9r.us.kg
  ws-opts:
    path: /id-tsel
    headers:
      Host: mmx.vpnoir9r.us.kg</textarea>
 </div>
<div style="display: none;">
   <textarea id="clashNtls/id-tsel">- name: Telekomunikasi Indonesia (ID)
  server: mmx.vpnoir9r.us.kg
  port: 80
  type: vless
  uuid: 02d83bd1-0c39-4d13-b70f-d9a021b68cdc
  cipher: auto
  tls: false
  udp: true
  skip-cert-verify: true
  network: ws
  ws-opts:
    path: /id-tsel
    headers:
      Host: mmx.vpnoir9r.us.kg</textarea>
 </div>
<div class="config-section">
    <p><strong>ISP  :  Telekomunikasi Indonesia (ID)</strong> </p>
    <hr/>
    <div class="config-toggle">
        <button class="button" onclick="toggleConfig(this, 'show clash', 'hide clash')">Show Clash</button>
        <div class="config-content">
            <div class="config-block">
                <h3>TLS:</h3>
                <p class="config">- name: Telekomunikasi Indonesia (ID)
  server: mmx.vpnoir9r.us.kg
  port: 443
  type: vless
  uuid: f2d58d9b-74ff-45ea-931d-7dcb3516aff4
  cipher: auto
  tls: true
  udp: true
  skip-cert-verify: true
  network: ws
  servername: mmx.vpnoir9r.us.kg
  ws-opts:
    path: /id-tsel
    headers:
      Host: mmx.vpnoir9r.us.kg</p>
                <button class="button" onclick='copyClash("clashTls/id-tsel")'><i class="fa fa-clipboard"></i>Copy</button>
            </div>
            <hr />
            <div class="config-block">
                <h3>NTLS:</h3>
                <p class="config">- name: Telekomunikasi Indonesia (ID)
  server: mmx.vpnoir9r.us.kg
  port: 80
  type: vless
  uuid: 02d83bd1-0c39-4d13-b70f-d9a021b68cdc
  cipher: auto
  tls: false
  udp: true
  skip-cert-verify: true
  network: ws
  ws-opts:
    path: /id-tsel
    headers:
      Host: mmx.vpnoir9r.us.kg</p>
                <button class="button" onclick='copyClash("clashNtls/id-tsel")'><i class="fa fa-clipboard"></i>Copy</button>
            </div>
        </div>
    </div>
</div>
<hr class="config-divider" />
<div style="display: none;">
   <textarea id="clashTls/sgaka1">- name: Akamai International B.V. (SG)
  server: mmx.vpnoir9r.us.kg
  port: 443
  type: vless
  uuid: ae3c4f73-abed-4c68-92c1-19a39a1fbe07
  cipher: auto
  tls: true
  udp: true
  skip-cert-verify: true
  network: ws
  servername: mmx.vpnoir9r.us.kg
  ws-opts:
    path: /sgaka1
    headers:
      Host: mmx.vpnoir9r.us.kg</textarea>
 </div>
<div style="display: none;">
   <textarea id="clashNtls/sgaka1">- name: Akamai International B.V. (SG)
  server: mmx.vpnoir9r.us.kg
  port: 80
  type: vless
  uuid: 2d3c7a3e-9dfb-4b64-92ad-3b15627d6e98
  cipher: auto
  tls: false
  udp: true
  skip-cert-verify: true
  network: ws
  ws-opts:
    path: /sgaka1
    headers:
      Host: mmx.vpnoir9r.us.kg</textarea>
 </div>
<div class="config-section">
    <p><strong>ISP  :  Akamai International B.V. (SG)</strong> </p>
    <hr/>
    <div class="config-toggle">
        <button class="button" onclick="toggleConfig(this, 'show clash', 'hide clash')">Show Clash</button>
        <div class="config-content">
            <div class="config-block">
                <h3>TLS:</h3>
                <p class="config">- name: Akamai International B.V. (SG)
  server: mmx.vpnoir9r.us.kg
  port: 443
  type: vless
  uuid: ae3c4f73-abed-4c68-92c1-19a39a1fbe07
  cipher: auto
  tls: true
  udp: true
  skip-cert-verify: true
  network: ws
  servername: mmx.vpnoir9r.us.kg
  ws-opts:
    path: /sgaka1
    headers:
      Host: mmx.vpnoir9r.us.kg</p>
                <button class="button" onclick='copyClash("clashTls/sgaka1")'><i class="fa fa-clipboard"></i>Copy</button>
            </div>
            <hr />
            <div class="config-block">
                <h3>NTLS:</h3>
                <p class="config">- name: Akamai International B.V. (SG)
  server: mmx.vpnoir9r.us.kg
  port: 80
  type: vless
  uuid: 2d3c7a3e-9dfb-4b64-92ad-3b15627d6e98
  cipher: auto
  tls: false
  udp: true
  skip-cert-verify: true
  network: ws
  ws-opts:
    path: /sgaka1
    headers:
      Host: mmx.vpnoir9r.us.kg</p>
                <button class="button" onclick='copyClash("clashNtls/sgaka1")'><i class="fa fa-clipboard"></i>Copy</button>
            </div>
        </div>
    </div>
</div>
<hr class="config-divider" />
<div style="display: none;">
   <textarea id="clashTls/my1">- name: Akamai International B.V. (MY)
  server: mmx.vpnoir9r.us.kg
  port: 443
  type: vless
  uuid: a60794ff-8285-40c9-a53f-0d47e415128b
  cipher: auto
  tls: true
  udp: true
  skip-cert-verify: true
  network: ws
  servername: mmx.vpnoir9r.us.kg
  ws-opts:
    path: /my1
    headers:
      Host: mmx.vpnoir9r.us.kg</textarea>
 </div>
<div style="display: none;">
   <textarea id="clashNtls/my1">- name: Akamai International B.V. (MY)
  server: mmx.vpnoir9r.us.kg
  port: 80
  type: vless
  uuid: 0b909acd-4072-4ee7-950c-47af95ffa841
  cipher: auto
  tls: false
  udp: true
  skip-cert-verify: true
  network: ws
  ws-opts:
    path: /my1
    headers:
      Host: mmx.vpnoir9r.us.kg</textarea>
 </div>
<div class="config-section">
    <p><strong>ISP  :  Akamai International B.V. (MY)</strong> </p>
    <hr/>
    <div class="config-toggle">
        <button class="button" onclick="toggleConfig(this, 'show clash', 'hide clash')">Show Clash</button>
        <div class="config-content">
            <div class="config-block">
                <h3>TLS:</h3>
                <p class="config">- name: Akamai International B.V. (MY)
  server: mmx.vpnoir9r.us.kg
  port: 443
  type: vless
  uuid: a60794ff-8285-40c9-a53f-0d47e415128b
  cipher: auto
  tls: true
  udp: true
  skip-cert-verify: true
  network: ws
  servername: mmx.vpnoir9r.us.kg
  ws-opts:
    path: /my1
    headers:
      Host: mmx.vpnoir9r.us.kg</p>
                <button class="button" onclick='copyClash("clashTls/my1")'><i class="fa fa-clipboard"></i>Copy</button>
            </div>
            <hr />
            <div class="config-block">
                <h3>NTLS:</h3>
                <p class="config">- name: Akamai International B.V. (MY)
  server: mmx.vpnoir9r.us.kg
  port: 80
  type: vless
  uuid: 0b909acd-4072-4ee7-950c-47af95ffa841
  cipher: auto
  tls: false
  udp: true
  skip-cert-verify: true
  network: ws
  ws-opts:
    path: /my1
    headers:
      Host: mmx.vpnoir9r.us.kg</p>
                <button class="button" onclick='copyClash("clashNtls/my1")'><i class="fa fa-clipboard"></i>Copy</button>
            </div>
        </div>
    </div>
</div>
<hr class="config-divider" />
<div style="display: none;">
   <textarea id="clashTls/sgtcc">- name: The Constant Company (SG)
  server: mmx.vpnoir9r.us.kg
  port: 443
  type: vless
  uuid: abf770cb-facc-4044-9918-c3fe658de5b3
  cipher: auto
  tls: true
  udp: true
  skip-cert-verify: true
  network: ws
  servername: mmx.vpnoir9r.us.kg
  ws-opts:
    path: /sgtcc
    headers:
      Host: mmx.vpnoir9r.us.kg</textarea>
 </div>
<div style="display: none;">
   <textarea id="clashNtls/sgtcc">- name: The Constant Company (SG)
  server: mmx.vpnoir9r.us.kg
  port: 80
  type: vless
  uuid: 16dfb762-1944-46a6-af41-16754e8c8fa0
  cipher: auto
  tls: false
  udp: true
  skip-cert-verify: true
  network: ws
  ws-opts:
    path: /sgtcc
    headers:
      Host: mmx.vpnoir9r.us.kg</textarea>
 </div>
<div class="config-section">
    <p><strong>ISP  :  The Constant Company (SG)</strong> </p>
    <hr/>
    <div class="config-toggle">
        <button class="button" onclick="toggleConfig(this, 'show clash', 'hide clash')">Show Clash</button>
        <div class="config-content">
            <div class="config-block">
                <h3>TLS:</h3>
                <p class="config">- name: The Constant Company (SG)
  server: mmx.vpnoir9r.us.kg
  port: 443
  type: vless
  uuid: abf770cb-facc-4044-9918-c3fe658de5b3
  cipher: auto
  tls: true
  udp: true
  skip-cert-verify: true
  network: ws
  servername: mmx.vpnoir9r.us.kg
  ws-opts:
    path: /sgtcc
    headers:
      Host: mmx.vpnoir9r.us.kg</p>
                <button class="button" onclick='copyClash("clashTls/sgtcc")'><i class="fa fa-clipboard"></i>Copy</button>
            </div>
            <hr />
            <div class="config-block">
                <h3>NTLS:</h3>
                <p class="config">- name: The Constant Company (SG)
  server: mmx.vpnoir9r.us.kg
  port: 80
  type: vless
  uuid: 16dfb762-1944-46a6-af41-16754e8c8fa0
  cipher: auto
  tls: false
  udp: true
  skip-cert-verify: true
  network: ws
  ws-opts:
    path: /sgtcc
    headers:
      Host: mmx.vpnoir9r.us.kg</p>
                <button class="button" onclick='copyClash("clashNtls/sgtcc")'><i class="fa fa-clipboard"></i>Copy</button>
            </div>
        </div>
    </div>
</div>
<hr class="config-divider" />
<div style="display: none;">
   <textarea id="clashTls/sgtencent">- name: Shenzhen Tencent Computer Systems Company Limited (SG)
  server: mmx.vpnoir9r.us.kg
  port: 443
  type: vless
  uuid: 7a45926b-fe7c-485d-9de9-027a04708c64
  cipher: auto
  tls: true
  udp: true
  skip-cert-verify: true
  network: ws
  servername: mmx.vpnoir9r.us.kg
  ws-opts:
    path: /sgtencent
    headers:
      Host: mmx.vpnoir9r.us.kg</textarea>
 </div>
<div style="display: none;">
   <textarea id="clashNtls/sgtencent">- name: Shenzhen Tencent Computer Systems Company Limited (SG)
  server: mmx.vpnoir9r.us.kg
  port: 80
  type: vless
  uuid: 8494cade-8d9a-4f1d-86be-c556e79f2501
  cipher: auto
  tls: false
  udp: true
  skip-cert-verify: true
  network: ws
  ws-opts:
    path: /sgtencent
    headers:
      Host: mmx.vpnoir9r.us.kg</textarea>
 </div>
<div class="config-section">
    <p><strong>ISP  :  Shenzhen Tencent Computer Systems Company Limited (SG)</strong> </p>
    <hr/>
    <div class="config-toggle">
        <button class="button" onclick="toggleConfig(this, 'show clash', 'hide clash')">Show Clash</button>
        <div class="config-content">
            <div class="config-block">
                <h3>TLS:</h3>
                <p class="config">- name: Shenzhen Tencent Computer Systems Company Limited (SG)
  server: mmx.vpnoir9r.us.kg
  port: 443
  type: vless
  uuid: 7a45926b-fe7c-485d-9de9-027a04708c64
  cipher: auto
  tls: true
  udp: true
  skip-cert-verify: true
  network: ws
  servername: mmx.vpnoir9r.us.kg
  ws-opts:
    path: /sgtencent
    headers:
      Host: mmx.vpnoir9r.us.kg</p>
                <button class="button" onclick='copyClash("clashTls/sgtencent")'><i class="fa fa-clipboard"></i>Copy</button>
            </div>
            <hr />
            <div class="config-block">
                <h3>NTLS:</h3>
                <p class="config">- name: Shenzhen Tencent Computer Systems Company Limited (SG)
  server: mmx.vpnoir9r.us.kg
  port: 80
  type: vless
  uuid: 8494cade-8d9a-4f1d-86be-c556e79f2501
  cipher: auto
  tls: false
  udp: true
  skip-cert-verify: true
  network: ws
  ws-opts:
    path: /sgtencent
    headers:
      Host: mmx.vpnoir9r.us.kg</p>
                <button class="button" onclick='copyClash("clashNtls/sgtencent")'><i class="fa fa-clipboard"></i>Copy</button>
            </div>
        </div>
    </div>
</div>
<hr class="config-divider" />
<div style="display: none;">
   <textarea id="clashTls/IFOG">- name: iFog GmbH (SG)
  server: mmx.vpnoir9r.us.kg
  port: 443
  type: vless
  uuid: 1acbc9d8-3fa0-4d14-8ea2-e775cce3c0f9
  cipher: auto
  tls: true
  udp: true
  skip-cert-verify: true
  network: ws
  servername: mmx.vpnoir9r.us.kg
  ws-opts:
    path: /IFOG
    headers:
      Host: mmx.vpnoir9r.us.kg</textarea>
 </div>
<div style="display: none;">
   <textarea id="clashNtls/IFOG">- name: iFog GmbH (SG)
  server: mmx.vpnoir9r.us.kg
  port: 80
  type: vless
  uuid: 14950cb0-9e30-4032-8087-cdc44550cd02
  cipher: auto
  tls: false
  udp: true
  skip-cert-verify: true
  network: ws
  ws-opts:
    path: /IFOG
    headers:
      Host: mmx.vpnoir9r.us.kg</textarea>
 </div>
<div class="config-section">
    <p><strong>ISP  :  iFog GmbH (SG)</strong> </p>
    <hr/>
    <div class="config-toggle">
        <button class="button" onclick="toggleConfig(this, 'show clash', 'hide clash')">Show Clash</button>
        <div class="config-content">
            <div class="config-block">
                <h3>TLS:</h3>
                <p class="config">- name: iFog GmbH (SG)
  server: mmx.vpnoir9r.us.kg
  port: 443
  type: vless
  uuid: 1acbc9d8-3fa0-4d14-8ea2-e775cce3c0f9
  cipher: auto
  tls: true
  udp: true
  skip-cert-verify: true
  network: ws
  servername: mmx.vpnoir9r.us.kg
  ws-opts:
    path: /IFOG
    headers:
      Host: mmx.vpnoir9r.us.kg</p>
                <button class="button" onclick='copyClash("clashTls/IFOG")'><i class="fa fa-clipboard"></i>Copy</button>
            </div>
            <hr />
            <div class="config-block">
                <h3>NTLS:</h3>
                <p class="config">- name: iFog GmbH (SG)
  server: mmx.vpnoir9r.us.kg
  port: 80
  type: vless
  uuid: 14950cb0-9e30-4032-8087-cdc44550cd02
  cipher: auto
  tls: false
  udp: true
  skip-cert-verify: true
  network: ws
  ws-opts:
    path: /IFOG
    headers:
      Host: mmx.vpnoir9r.us.kg</p>
                <button class="button" onclick='copyClash("clashNtls/IFOG")'><i class="fa fa-clipboard"></i>Copy</button>
            </div>
        </div>
    </div>
</div>
<hr class="config-divider" />
<div style="display: none;">
   <textarea id="clashTls/REGXA">- name: Ipxo LLC (SG)
  server: mmx.vpnoir9r.us.kg
  port: 443
  type: vless
  uuid: 6b76b4a7-f9d8-4da0-821e-a91ffb970749
  cipher: auto
  tls: true
  udp: true
  skip-cert-verify: true
  network: ws
  servername: mmx.vpnoir9r.us.kg
  ws-opts:
    path: /REGXA
    headers:
      Host: mmx.vpnoir9r.us.kg</textarea>
 </div>
<div style="display: none;">
   <textarea id="clashNtls/REGXA">- name: Ipxo LLC (SG)
  server: mmx.vpnoir9r.us.kg
  port: 80
  type: vless
  uuid: 3cb36db2-da03-44af-bdfc-28e4cc40f1d4
  cipher: auto
  tls: false
  udp: true
  skip-cert-verify: true
  network: ws
  ws-opts:
    path: /REGXA
    headers:
      Host: mmx.vpnoir9r.us.kg</textarea>
 </div>
<div class="config-section">
    <p><strong>ISP  :  Ipxo LLC (SG)</strong> </p>
    <hr/>
    <div class="config-toggle">
        <button class="button" onclick="toggleConfig(this, 'show clash', 'hide clash')">Show Clash</button>
        <div class="config-content">
            <div class="config-block">
                <h3>TLS:</h3>
                <p class="config">- name: Ipxo LLC (SG)
  server: mmx.vpnoir9r.us.kg
  port: 443
  type: vless
  uuid: 6b76b4a7-f9d8-4da0-821e-a91ffb970749
  cipher: auto
  tls: true
  udp: true
  skip-cert-verify: true
  network: ws
  servername: mmx.vpnoir9r.us.kg
  ws-opts:
    path: /REGXA
    headers:
      Host: mmx.vpnoir9r.us.kg</p>
                <button class="button" onclick='copyClash("clashTls/REGXA")'><i class="fa fa-clipboard"></i>Copy</button>
            </div>
            <hr />
            <div class="config-block">
                <h3>NTLS:</h3>
                <p class="config">- name: Ipxo LLC (SG)
  server: mmx.vpnoir9r.us.kg
  port: 80
  type: vless
  uuid: 3cb36db2-da03-44af-bdfc-28e4cc40f1d4
  cipher: auto
  tls: false
  udp: true
  skip-cert-verify: true
  network: ws
  ws-opts:
    path: /REGXA
    headers:
      Host: mmx.vpnoir9r.us.kg</p>
                <button class="button" onclick='copyClash("clashNtls/REGXA")'><i class="fa fa-clipboard"></i>Copy</button>
            </div>
        </div>
    </div>
</div>
<hr class="config-divider" />
<div style="display: none;">
   <textarea id="clashTls/CONTABO-SG">- name: Contabo GmbH (SG)
  server: mmx.vpnoir9r.us.kg
  port: 443
  type: vless
  uuid: 0b32ebe4-162c-49a9-abe8-9cf4bff87a4f
  cipher: auto
  tls: true
  udp: true
  skip-cert-verify: true
  network: ws
  servername: mmx.vpnoir9r.us.kg
  ws-opts:
    path: /CONTABO-SG
    headers:
      Host: mmx.vpnoir9r.us.kg</textarea>
 </div>
<div style="display: none;">
   <textarea id="clashNtls/CONTABO-SG">- name: Contabo GmbH (SG)
  server: mmx.vpnoir9r.us.kg
  port: 80
  type: vless
  uuid: aad58f57-0484-4b65-a483-801926b03bc6
  cipher: auto
  tls: false
  udp: true
  skip-cert-verify: true
  network: ws
  ws-opts:
    path: /CONTABO-SG
    headers:
      Host: mmx.vpnoir9r.us.kg</textarea>
 </div>
<div class="config-section">
    <p><strong>ISP  :  Contabo GmbH (SG)</strong> </p>
    <hr/>
    <div class="config-toggle">
        <button class="button" onclick="toggleConfig(this, 'show clash', 'hide clash')">Show Clash</button>
        <div class="config-content">
            <div class="config-block">
                <h3>TLS:</h3>
                <p class="config">- name: Contabo GmbH (SG)
  server: mmx.vpnoir9r.us.kg
  port: 443
  type: vless
  uuid: 0b32ebe4-162c-49a9-abe8-9cf4bff87a4f
  cipher: auto
  tls: true
  udp: true
  skip-cert-verify: true
  network: ws
  servername: mmx.vpnoir9r.us.kg
  ws-opts:
    path: /CONTABO-SG
    headers:
      Host: mmx.vpnoir9r.us.kg</p>
                <button class="button" onclick='copyClash("clashTls/CONTABO-SG")'><i class="fa fa-clipboard"></i>Copy</button>
            </div>
            <hr />
            <div class="config-block">
                <h3>NTLS:</h3>
                <p class="config">- name: Contabo GmbH (SG)
  server: mmx.vpnoir9r.us.kg
  port: 80
  type: vless
  uuid: aad58f57-0484-4b65-a483-801926b03bc6
  cipher: auto
  tls: false
  udp: true
  skip-cert-verify: true
  network: ws
  ws-opts:
    path: /CONTABO-SG
    headers:
      Host: mmx.vpnoir9r.us.kg</p>
                <button class="button" onclick='copyClash("clashNtls/CONTABO-SG")'><i class="fa fa-clipboard"></i>Copy</button>
            </div>
        </div>
    </div>
</div>
<hr class="config-divider" />
<div style="display: none;">
   <textarea id="clashTls/sgalibaba">- name: Alibaba (US) Technology Co., Ltd. (SG)
  server: mmx.vpnoir9r.us.kg
  port: 443
  type: vless
  uuid: 1265ea1e-9b60-4275-8121-111e063a637d
  cipher: auto
  tls: true
  udp: true
  skip-cert-verify: true
  network: ws
  servername: mmx.vpnoir9r.us.kg
  ws-opts:
    path: /sgalibaba
    headers:
      Host: mmx.vpnoir9r.us.kg</textarea>
 </div>
<div style="display: none;">
   <textarea id="clashNtls/sgalibaba">- name: Alibaba (US) Technology Co., Ltd. (SG)
  server: mmx.vpnoir9r.us.kg
  port: 80
  type: vless
  uuid: 07e71568-0411-4334-8cbc-1a9f10d25c77
  cipher: auto
  tls: false
  udp: true
  skip-cert-verify: true
  network: ws
  ws-opts:
    path: /sgalibaba
    headers:
      Host: mmx.vpnoir9r.us.kg</textarea>
 </div>
<div class="config-section">
    <p><strong>ISP  :  Alibaba (US) Technology Co., Ltd. (SG)</strong> </p>
    <hr/>
    <div class="config-toggle">
        <button class="button" onclick="toggleConfig(this, 'show clash', 'hide clash')">Show Clash</button>
        <div class="config-content">
            <div class="config-block">
                <h3>TLS:</h3>
                <p class="config">- name: Alibaba (US) Technology Co., Ltd. (SG)
  server: mmx.vpnoir9r.us.kg
  port: 443
  type: vless
  uuid: 1265ea1e-9b60-4275-8121-111e063a637d
  cipher: auto
  tls: true
  udp: true
  skip-cert-verify: true
  network: ws
  servername: mmx.vpnoir9r.us.kg
  ws-opts:
    path: /sgalibaba
    headers:
      Host: mmx.vpnoir9r.us.kg</p>
                <button class="button" onclick='copyClash("clashTls/sgalibaba")'><i class="fa fa-clipboard"></i>Copy</button>
            </div>
            <hr />
            <div class="config-block">
                <h3>NTLS:</h3>
                <p class="config">- name: Alibaba (US) Technology Co., Ltd. (SG)
  server: mmx.vpnoir9r.us.kg
  port: 80
  type: vless
  uuid: 07e71568-0411-4334-8cbc-1a9f10d25c77
  cipher: auto
  tls: false
  udp: true
  skip-cert-verify: true
  network: ws
  ws-opts:
    path: /sgalibaba
    headers:
      Host: mmx.vpnoir9r.us.kg</p>
                <button class="button" onclick='copyClash("clashNtls/sgalibaba")'><i class="fa fa-clipboard"></i>Copy</button>
            </div>
        </div>
    </div>
</div>
<hr class="config-divider" />
<div style="display: none;">
   <textarea id="clashTls/sgakamai">- name: Akamai Technologies, Inc. (SG)
  server: mmx.vpnoir9r.us.kg
  port: 443
  type: vless
  uuid: 540e80cf-00b3-453e-8954-c45e1e643454
  cipher: auto
  tls: true
  udp: true
  skip-cert-verify: true
  network: ws
  servername: mmx.vpnoir9r.us.kg
  ws-opts:
    path: /sgakamai
    headers:
      Host: mmx.vpnoir9r.us.kg</textarea>
 </div>
<div style="display: none;">
   <textarea id="clashNtls/sgakamai">- name: Akamai Technologies, Inc. (SG)
  server: mmx.vpnoir9r.us.kg
  port: 80
  type: vless
  uuid: b8e51941-2e63-42b8-b40b-eca7f364de44
  cipher: auto
  tls: false
  udp: true
  skip-cert-verify: true
  network: ws
  ws-opts:
    path: /sgakamai
    headers:
      Host: mmx.vpnoir9r.us.kg</textarea>
 </div>
<div class="config-section">
    <p><strong>ISP  :  Akamai Technologies, Inc. (SG)</strong> </p>
    <hr/>
    <div class="config-toggle">
        <button class="button" onclick="toggleConfig(this, 'show clash', 'hide clash')">Show Clash</button>
        <div class="config-content">
            <div class="config-block">
                <h3>TLS:</h3>
                <p class="config">- name: Akamai Technologies, Inc. (SG)
  server: mmx.vpnoir9r.us.kg
  port: 443
  type: vless
  uuid: 540e80cf-00b3-453e-8954-c45e1e643454
  cipher: auto
  tls: true
  udp: true
  skip-cert-verify: true
  network: ws
  servername: mmx.vpnoir9r.us.kg
  ws-opts:
    path: /sgakamai
    headers:
      Host: mmx.vpnoir9r.us.kg</p>
                <button class="button" onclick='copyClash("clashTls/sgakamai")'><i class="fa fa-clipboard"></i>Copy</button>
            </div>
            <hr />
            <div class="config-block">
                <h3>NTLS:</h3>
                <p class="config">- name: Akamai Technologies, Inc. (SG)
  server: mmx.vpnoir9r.us.kg
  port: 80
  type: vless
  uuid: b8e51941-2e63-42b8-b40b-eca7f364de44
  cipher: auto
  tls: false
  udp: true
  skip-cert-verify: true
  network: ws
  ws-opts:
    path: /sgakamai
    headers:
      Host: mmx.vpnoir9r.us.kg</p>
                <button class="button" onclick='copyClash("clashNtls/sgakamai")'><i class="fa fa-clipboard"></i>Copy</button>
            </div>
        </div>
    </div>
</div>
<hr class="config-divider" />
<div style="display: none;">
   <textarea id="clashTls/idakamai">- name: Akamai Technologies, Inc. (ID)
  server: mmx.vpnoir9r.us.kg
  port: 443
  type: vless
  uuid: 9db57863-5e3a-43ea-a897-717da0b8881f
  cipher: auto
  tls: true
  udp: true
  skip-cert-verify: true
  network: ws
  servername: mmx.vpnoir9r.us.kg
  ws-opts:
    path: /idakamai
    headers:
      Host: mmx.vpnoir9r.us.kg</textarea>
 </div>
<div style="display: none;">
   <textarea id="clashNtls/idakamai">- name: Akamai Technologies, Inc. (ID)
  server: mmx.vpnoir9r.us.kg
  port: 80
  type: vless
  uuid: 4cc906d1-8201-417d-8490-fe6e7608cc9b
  cipher: auto
  tls: false
  udp: true
  skip-cert-verify: true
  network: ws
  ws-opts:
    path: /idakamai
    headers:
      Host: mmx.vpnoir9r.us.kg</textarea>
 </div>
<div class="config-section">
    <p><strong>ISP  :  Akamai Technologies, Inc. (ID)</strong> </p>
    <hr/>
    <div class="config-toggle">
        <button class="button" onclick="toggleConfig(this, 'show clash', 'hide clash')">Show Clash</button>
        <div class="config-content">
            <div class="config-block">
                <h3>TLS:</h3>
                <p class="config">- name: Akamai Technologies, Inc. (ID)
  server: mmx.vpnoir9r.us.kg
  port: 443
  type: vless
  uuid: 9db57863-5e3a-43ea-a897-717da0b8881f
  cipher: auto
  tls: true
  udp: true
  skip-cert-verify: true
  network: ws
  servername: mmx.vpnoir9r.us.kg
  ws-opts:
    path: /idakamai
    headers:
      Host: mmx.vpnoir9r.us.kg</p>
                <button class="button" onclick='copyClash("clashTls/idakamai")'><i class="fa fa-clipboard"></i>Copy</button>
            </div>
            <hr />
            <div class="config-block">
                <h3>NTLS:</h3>
                <p class="config">- name: Akamai Technologies, Inc. (ID)
  server: mmx.vpnoir9r.us.kg
  port: 80
  type: vless
  uuid: 4cc906d1-8201-417d-8490-fe6e7608cc9b
  cipher: auto
  tls: false
  udp: true
  skip-cert-verify: true
  network: ws
  ws-opts:
    path: /idakamai
    headers:
      Host: mmx.vpnoir9r.us.kg</p>
                <button class="button" onclick='copyClash("clashNtls/idakamai")'><i class="fa fa-clipboard"></i>Copy</button>
            </div>
        </div>
    </div>
</div>
<hr class="config-divider" />
<div style="display: none;">
   <textarea id="clashTls/sghz">- name: Hetzner Online GmbH (SG)
  server: mmx.vpnoir9r.us.kg
  port: 443
  type: vless
  uuid: 762bc721-1856-49a4-abf8-e4a08bb7d6fe
  cipher: auto
  tls: true
  udp: true
  skip-cert-verify: true
  network: ws
  servername: mmx.vpnoir9r.us.kg
  ws-opts:
    path: /sghz
    headers:
      Host: mmx.vpnoir9r.us.kg</textarea>
 </div>
<div style="display: none;">
   <textarea id="clashNtls/sghz">- name: Hetzner Online GmbH (SG)
  server: mmx.vpnoir9r.us.kg
  port: 80
  type: vless
  uuid: 409d0449-eba4-4e04-9d32-5e32bb1069c0
  cipher: auto
  tls: false
  udp: true
  skip-cert-verify: true
  network: ws
  ws-opts:
    path: /sghz
    headers:
      Host: mmx.vpnoir9r.us.kg</textarea>
 </div>
<div class="config-section">
    <p><strong>ISP  :  Hetzner Online GmbH (SG)</strong> </p>
    <hr/>
    <div class="config-toggle">
        <button class="button" onclick="toggleConfig(this, 'show clash', 'hide clash')">Show Clash</button>
        <div class="config-content">
            <div class="config-block">
                <h3>TLS:</h3>
                <p class="config">- name: Hetzner Online GmbH (SG)
  server: mmx.vpnoir9r.us.kg
  port: 443
  type: vless
  uuid: 762bc721-1856-49a4-abf8-e4a08bb7d6fe
  cipher: auto
  tls: true
  udp: true
  skip-cert-verify: true
  network: ws
  servername: mmx.vpnoir9r.us.kg
  ws-opts:
    path: /sghz
    headers:
      Host: mmx.vpnoir9r.us.kg</p>
                <button class="button" onclick='copyClash("clashTls/sghz")'><i class="fa fa-clipboard"></i>Copy</button>
            </div>
            <hr />
            <div class="config-block">
                <h3>NTLS:</h3>
                <p class="config">- name: Hetzner Online GmbH (SG)
  server: mmx.vpnoir9r.us.kg
  port: 80
  type: vless
  uuid: 409d0449-eba4-4e04-9d32-5e32bb1069c0
  cipher: auto
  tls: false
  udp: true
  skip-cert-verify: true
  network: ws
  ws-opts:
    path: /sghz
    headers:
      Host: mmx.vpnoir9r.us.kg</p>
                <button class="button" onclick='copyClash("clashNtls/sghz")'><i class="fa fa-clipboard"></i>Copy</button>
            </div>
        </div>
    </div>
</div>
<hr class="config-divider" />
<div style="display: none;">
   <textarea id="clashTls/GCPID">- name: Google LLC (ID)
  server: mmx.vpnoir9r.us.kg
  port: 443
  type: vless
  uuid: fb4b7759-16d8-4d03-b3cc-d64f653587f4
  cipher: auto
  tls: true
  udp: true
  skip-cert-verify: true
  network: ws
  servername: mmx.vpnoir9r.us.kg
  ws-opts:
    path: /GCPID
    headers:
      Host: mmx.vpnoir9r.us.kg</textarea>
 </div>
<div style="display: none;">
   <textarea id="clashNtls/GCPID">- name: Google LLC (ID)
  server: mmx.vpnoir9r.us.kg
  port: 80
  type: vless
  uuid: 1a2be59c-5f92-434c-a2c9-efb5b00ac0b0
  cipher: auto
  tls: false
  udp: true
  skip-cert-verify: true
  network: ws
  ws-opts:
    path: /GCPID
    headers:
      Host: mmx.vpnoir9r.us.kg</textarea>
 </div>
<div class="config-section">
    <p><strong>ISP  :  Google LLC (ID)</strong> </p>
    <hr/>
    <div class="config-toggle">
        <button class="button" onclick="toggleConfig(this, 'show clash', 'hide clash')">Show Clash</button>
        <div class="config-content">
            <div class="config-block">
                <h3>TLS:</h3>
                <p class="config">- name: Google LLC (ID)
  server: mmx.vpnoir9r.us.kg
  port: 443
  type: vless
  uuid: fb4b7759-16d8-4d03-b3cc-d64f653587f4
  cipher: auto
  tls: true
  udp: true
  skip-cert-verify: true
  network: ws
  servername: mmx.vpnoir9r.us.kg
  ws-opts:
    path: /GCPID
    headers:
      Host: mmx.vpnoir9r.us.kg</p>
                <button class="button" onclick='copyClash("clashTls/GCPID")'><i class="fa fa-clipboard"></i>Copy</button>
            </div>
            <hr />
            <div class="config-block">
                <h3>NTLS:</h3>
                <p class="config">- name: Google LLC (ID)
  server: mmx.vpnoir9r.us.kg
  port: 80
  type: vless
  uuid: 1a2be59c-5f92-434c-a2c9-efb5b00ac0b0
  cipher: auto
  tls: false
  udp: true
  skip-cert-verify: true
  network: ws
  ws-opts:
    path: /GCPID
    headers:
      Host: mmx.vpnoir9r.us.kg</p>
                <button class="button" onclick='copyClash("clashNtls/GCPID")'><i class="fa fa-clipboard"></i>Copy</button>
            </div>
        </div>
    </div>
</div>
<hr class="config-divider" />
<div style="display: none;">
   <textarea id="clashTls/my2">- name: ADSL Streamyx Telekom Malaysia (MY)
  server: mmx.vpnoir9r.us.kg
  port: 443
  type: vless
  uuid: 2944aeb1-19fb-4a6c-a736-4f63394618eb
  cipher: auto
  tls: true
  udp: true
  skip-cert-verify: true
  network: ws
  servername: mmx.vpnoir9r.us.kg
  ws-opts:
    path: /my2
    headers:
      Host: mmx.vpnoir9r.us.kg</textarea>
 </div>
<div style="display: none;">
   <textarea id="clashNtls/my2">- name: ADSL Streamyx Telekom Malaysia (MY)
  server: mmx.vpnoir9r.us.kg
  port: 80
  type: vless
  uuid: 965c7869-81bc-404e-919e-1d03e06f79a5
  cipher: auto
  tls: false
  udp: true
  skip-cert-verify: true
  network: ws
  ws-opts:
    path: /my2
    headers:
      Host: mmx.vpnoir9r.us.kg</textarea>
 </div>
<div class="config-section">
    <p><strong>ISP  :  ADSL Streamyx Telekom Malaysia (MY)</strong> </p>
    <hr/>
    <div class="config-toggle">
        <button class="button" onclick="toggleConfig(this, 'show clash', 'hide clash')">Show Clash</button>
        <div class="config-content">
            <div class="config-block">
                <h3>TLS:</h3>
                <p class="config">- name: ADSL Streamyx Telekom Malaysia (MY)
  server: mmx.vpnoir9r.us.kg
  port: 443
  type: vless
  uuid: 2944aeb1-19fb-4a6c-a736-4f63394618eb
  cipher: auto
  tls: true
  udp: true
  skip-cert-verify: true
  network: ws
  servername: mmx.vpnoir9r.us.kg
  ws-opts:
    path: /my2
    headers:
      Host: mmx.vpnoir9r.us.kg</p>
                <button class="button" onclick='copyClash("clashTls/my2")'><i class="fa fa-clipboard"></i>Copy</button>
            </div>
            <hr />
            <div class="config-block">
                <h3>NTLS:</h3>
                <p class="config">- name: ADSL Streamyx Telekom Malaysia (MY)
  server: mmx.vpnoir9r.us.kg
  port: 80
  type: vless
  uuid: 965c7869-81bc-404e-919e-1d03e06f79a5
  cipher: auto
  tls: false
  udp: true
  skip-cert-verify: true
  network: ws
  ws-opts:
    path: /my2
    headers:
      Host: mmx.vpnoir9r.us.kg</p>
                <button class="button" onclick='copyClash("clashNtls/my2")'><i class="fa fa-clipboard"></i>Copy</button>
            </div>
        </div>
    </div>
</div>
<hr class="config-divider" />
<div style="display: none;">
   <textarea id="clashTls/CDSGLOBALSG">- name: Capitalonline Data Service (HK) Co (SG)
  server: mmx.vpnoir9r.us.kg
  port: 443
  type: vless
  uuid: 6f73cbd0-ebbb-41c9-a763-f993b85e6f45
  cipher: auto
  tls: true
  udp: true
  skip-cert-verify: true
  network: ws
  servername: mmx.vpnoir9r.us.kg
  ws-opts:
    path: /CDSGLOBALSG
    headers:
      Host: mmx.vpnoir9r.us.kg</textarea>
 </div>
<div style="display: none;">
   <textarea id="clashNtls/CDSGLOBALSG">- name: Capitalonline Data Service (HK) Co (SG)
  server: mmx.vpnoir9r.us.kg
  port: 80
  type: vless
  uuid: 6174ed79-8272-4311-a885-3704f2aa7221
  cipher: auto
  tls: false
  udp: true
  skip-cert-verify: true
  network: ws
  ws-opts:
    path: /CDSGLOBALSG
    headers:
      Host: mmx.vpnoir9r.us.kg</textarea>
 </div>
<div class="config-section">
    <p><strong>ISP  :  Capitalonline Data Service (HK) Co (SG)</strong> </p>
    <hr/>
    <div class="config-toggle">
        <button class="button" onclick="toggleConfig(this, 'show clash', 'hide clash')">Show Clash</button>
        <div class="config-content">
            <div class="config-block">
                <h3>TLS:</h3>
                <p class="config">- name: Capitalonline Data Service (HK) Co (SG)
  server: mmx.vpnoir9r.us.kg
  port: 443
  type: vless
  uuid: 6f73cbd0-ebbb-41c9-a763-f993b85e6f45
  cipher: auto
  tls: true
  udp: true
  skip-cert-verify: true
  network: ws
  servername: mmx.vpnoir9r.us.kg
  ws-opts:
    path: /CDSGLOBALSG
    headers:
      Host: mmx.vpnoir9r.us.kg</p>
                <button class="button" onclick='copyClash("clashTls/CDSGLOBALSG")'><i class="fa fa-clipboard"></i>Copy</button>
            </div>
            <hr />
            <div class="config-block">
                <h3>NTLS:</h3>
                <p class="config">- name: Capitalonline Data Service (HK) Co (SG)
  server: mmx.vpnoir9r.us.kg
  port: 80
  type: vless
  uuid: 6174ed79-8272-4311-a885-3704f2aa7221
  cipher: auto
  tls: false
  udp: true
  skip-cert-verify: true
  network: ws
  ws-opts:
    path: /CDSGLOBALSG
    headers:
      Host: mmx.vpnoir9r.us.kg</p>
                <button class="button" onclick='copyClash("clashNtls/CDSGLOBALSG")'><i class="fa fa-clipboard"></i>Copy</button>
            </div>
        </div>
    </div>
</div>
<hr class="config-divider" />
<div style="display: none;">
   <textarea id="clashTls/sgovhsas">- name: OVH SAS (SG)
  server: mmx.vpnoir9r.us.kg
  port: 443
  type: vless
  uuid: 41755827-5fb0-4e97-a77f-8437af371d05
  cipher: auto
  tls: true
  udp: true
  skip-cert-verify: true
  network: ws
  servername: mmx.vpnoir9r.us.kg
  ws-opts:
    path: /sgovhsas
    headers:
      Host: mmx.vpnoir9r.us.kg</textarea>
 </div>
<div style="display: none;">
   <textarea id="clashNtls/sgovhsas">- name: OVH SAS (SG)
  server: mmx.vpnoir9r.us.kg
  port: 80
  type: vless
  uuid: 93a545e2-91b2-4030-9157-b433abbb9fe0
  cipher: auto
  tls: false
  udp: true
  skip-cert-verify: true
  network: ws
  ws-opts:
    path: /sgovhsas
    headers:
      Host: mmx.vpnoir9r.us.kg</textarea>
 </div>
<div class="config-section">
    <p><strong>ISP  :  OVH SAS (SG)</strong> </p>
    <hr/>
    <div class="config-toggle">
        <button class="button" onclick="toggleConfig(this, 'show clash', 'hide clash')">Show Clash</button>
        <div class="config-content">
            <div class="config-block">
                <h3>TLS:</h3>
                <p class="config">- name: OVH SAS (SG)
  server: mmx.vpnoir9r.us.kg
  port: 443
  type: vless
  uuid: 41755827-5fb0-4e97-a77f-8437af371d05
  cipher: auto
  tls: true
  udp: true
  skip-cert-verify: true
  network: ws
  servername: mmx.vpnoir9r.us.kg
  ws-opts:
    path: /sgovhsas
    headers:
      Host: mmx.vpnoir9r.us.kg</p>
                <button class="button" onclick='copyClash("clashTls/sgovhsas")'><i class="fa fa-clipboard"></i>Copy</button>
            </div>
            <hr />
            <div class="config-block">
                <h3>NTLS:</h3>
                <p class="config">- name: OVH SAS (SG)
  server: mmx.vpnoir9r.us.kg
  port: 80
  type: vless
  uuid: 93a545e2-91b2-4030-9157-b433abbb9fe0
  cipher: auto
  tls: false
  udp: true
  skip-cert-verify: true
  network: ws
  ws-opts:
    path: /sgovhsas
    headers:
      Host: mmx.vpnoir9r.us.kg</p>
                <button class="button" onclick='copyClash("clashNtls/sgovhsas")'><i class="fa fa-clipboard"></i>Copy</button>
            </div>
        </div>
    </div>
</div>
<hr class="config-divider" />
<div style="display: none;">
   <textarea id="clashTls/sgdo">- name: DigitalOcean, LLC (SG)
  server: mmx.vpnoir9r.us.kg
  port: 443
  type: vless
  uuid: 9c488e3d-7f9f-405b-a425-986a5176ede7
  cipher: auto
  tls: true
  udp: true
  skip-cert-verify: true
  network: ws
  servername: mmx.vpnoir9r.us.kg
  ws-opts:
    path: /sgdo
    headers:
      Host: mmx.vpnoir9r.us.kg</textarea>
 </div>
<div style="display: none;">
   <textarea id="clashNtls/sgdo">- name: DigitalOcean, LLC (SG)
  server: mmx.vpnoir9r.us.kg
  port: 80
  type: vless
  uuid: b85c66db-8859-4836-b892-27ccd1474966
  cipher: auto
  tls: false
  udp: true
  skip-cert-verify: true
  network: ws
  ws-opts:
    path: /sgdo
    headers:
      Host: mmx.vpnoir9r.us.kg</textarea>
 </div>
<div class="config-section">
    <p><strong>ISP  :  DigitalOcean, LLC (SG)</strong> </p>
    <hr/>
    <div class="config-toggle">
        <button class="button" onclick="toggleConfig(this, 'show clash', 'hide clash')">Show Clash</button>
        <div class="config-content">
            <div class="config-block">
                <h3>TLS:</h3>
                <p class="config">- name: DigitalOcean, LLC (SG)
  server: mmx.vpnoir9r.us.kg
  port: 443
  type: vless
  uuid: 9c488e3d-7f9f-405b-a425-986a5176ede7
  cipher: auto
  tls: true
  udp: true
  skip-cert-verify: true
  network: ws
  servername: mmx.vpnoir9r.us.kg
  ws-opts:
    path: /sgdo
    headers:
      Host: mmx.vpnoir9r.us.kg</p>
                <button class="button" onclick='copyClash("clashTls/sgdo")'><i class="fa fa-clipboard"></i>Copy</button>
            </div>
            <hr />
            <div class="config-block">
                <h3>NTLS:</h3>
                <p class="config">- name: DigitalOcean, LLC (SG)
  server: mmx.vpnoir9r.us.kg
  port: 80
  type: vless
  uuid: b85c66db-8859-4836-b892-27ccd1474966
  cipher: auto
  tls: false
  udp: true
  skip-cert-verify: true
  network: ws
  ws-opts:
    path: /sgdo
    headers:
      Host: mmx.vpnoir9r.us.kg</p>
                <button class="button" onclick='copyClash("clashNtls/sgdo")'><i class="fa fa-clipboard"></i>Copy</button>
            </div>
        </div>
    </div>
</div>
<hr class="config-divider" />
<div style="display: none;">
   <textarea id="clashTls/sgnpo">- name: NPO G-net (SG)
  server: mmx.vpnoir9r.us.kg
  port: 443
  type: vless
  uuid: f23ca0a4-ff7e-4b85-b1d3-955cf70b4e7c
  cipher: auto
  tls: true
  udp: true
  skip-cert-verify: true
  network: ws
  servername: mmx.vpnoir9r.us.kg
  ws-opts:
    path: /sgnpo
    headers:
      Host: mmx.vpnoir9r.us.kg</textarea>
 </div>
<div style="display: none;">
   <textarea id="clashNtls/sgnpo">- name: NPO G-net (SG)
  server: mmx.vpnoir9r.us.kg
  port: 80
  type: vless
  uuid: 58b3c2a7-17dc-4814-9afd-bf069f85ebe9
  cipher: auto
  tls: false
  udp: true
  skip-cert-verify: true
  network: ws
  ws-opts:
    path: /sgnpo
    headers:
      Host: mmx.vpnoir9r.us.kg</textarea>
 </div>
<div class="config-section">
    <p><strong>ISP  :  NPO G-net (SG)</strong> </p>
    <hr/>
    <div class="config-toggle">
        <button class="button" onclick="toggleConfig(this, 'show clash', 'hide clash')">Show Clash</button>
        <div class="config-content">
            <div class="config-block">
                <h3>TLS:</h3>
                <p class="config">- name: NPO G-net (SG)
  server: mmx.vpnoir9r.us.kg
  port: 443
  type: vless
  uuid: f23ca0a4-ff7e-4b85-b1d3-955cf70b4e7c
  cipher: auto
  tls: true
  udp: true
  skip-cert-verify: true
  network: ws
  servername: mmx.vpnoir9r.us.kg
  ws-opts:
    path: /sgnpo
    headers:
      Host: mmx.vpnoir9r.us.kg</p>
                <button class="button" onclick='copyClash("clashTls/sgnpo")'><i class="fa fa-clipboard"></i>Copy</button>
            </div>
            <hr />
            <div class="config-block">
                <h3>NTLS:</h3>
                <p class="config">- name: NPO G-net (SG)
  server: mmx.vpnoir9r.us.kg
  port: 80
  type: vless
  uuid: 58b3c2a7-17dc-4814-9afd-bf069f85ebe9
  cipher: auto
  tls: false
  udp: true
  skip-cert-verify: true
  network: ws
  ws-opts:
    path: /sgnpo
    headers:
      Host: mmx.vpnoir9r.us.kg</p>
                <button class="button" onclick='copyClash("clashNtls/sgnpo")'><i class="fa fa-clipboard"></i>Copy</button>
            </div>
        </div>
    </div>
</div>
<hr class="config-divider" />
<div style="display: none;">
   <textarea id="clashTls/sgmegalayer">- name: HONG KONG Megalayer Technology Co., Limited (SG)
  server: mmx.vpnoir9r.us.kg
  port: 443
  type: vless
  uuid: 834622ad-4cb7-479a-8348-0575916ee382
  cipher: auto
  tls: true
  udp: true
  skip-cert-verify: true
  network: ws
  servername: mmx.vpnoir9r.us.kg
  ws-opts:
    path: /sgmegalayer
    headers:
      Host: mmx.vpnoir9r.us.kg</textarea>
 </div>
<div style="display: none;">
   <textarea id="clashNtls/sgmegalayer">- name: HONG KONG Megalayer Technology Co., Limited (SG)
  server: mmx.vpnoir9r.us.kg
  port: 80
  type: vless
  uuid: ca198ce2-2656-4ce4-9867-c2170c657946
  cipher: auto
  tls: false
  udp: true
  skip-cert-verify: true
  network: ws
  ws-opts:
    path: /sgmegalayer
    headers:
      Host: mmx.vpnoir9r.us.kg</textarea>
 </div>
<div class="config-section">
    <p><strong>ISP  :  HONG KONG Megalayer Technology Co., Limited (SG)</strong> </p>
    <hr/>
    <div class="config-toggle">
        <button class="button" onclick="toggleConfig(this, 'show clash', 'hide clash')">Show Clash</button>
        <div class="config-content">
            <div class="config-block">
                <h3>TLS:</h3>
                <p class="config">- name: HONG KONG Megalayer Technology Co., Limited (SG)
  server: mmx.vpnoir9r.us.kg
  port: 443
  type: vless
  uuid: 834622ad-4cb7-479a-8348-0575916ee382
  cipher: auto
  tls: true
  udp: true
  skip-cert-verify: true
  network: ws
  servername: mmx.vpnoir9r.us.kg
  ws-opts:
    path: /sgmegalayer
    headers:
      Host: mmx.vpnoir9r.us.kg</p>
                <button class="button" onclick='copyClash("clashTls/sgmegalayer")'><i class="fa fa-clipboard"></i>Copy</button>
            </div>
            <hr />
            <div class="config-block">
                <h3>NTLS:</h3>
                <p class="config">- name: HONG KONG Megalayer Technology Co., Limited (SG)
  server: mmx.vpnoir9r.us.kg
  port: 80
  type: vless
  uuid: ca198ce2-2656-4ce4-9867-c2170c657946
  cipher: auto
  tls: false
  udp: true
  skip-cert-verify: true
  network: ws
  ws-opts:
    path: /sgmegalayer
    headers:
      Host: mmx.vpnoir9r.us.kg</p>
                <button class="button" onclick='copyClash("clashNtls/sgmegalayer")'><i class="fa fa-clipboard"></i>Copy</button>
            </div>
        </div>
    </div>
</div>
<hr class="config-divider" />
<div style="display: none;">
   <textarea id="clashTls/sgoracle">- name: Oracle Corporation (SG)
  server: mmx.vpnoir9r.us.kg
  port: 443
  type: vless
  uuid: 4f60261d-48f3-41a0-9050-5d1e261619a7
  cipher: auto
  tls: true
  udp: true
  skip-cert-verify: true
  network: ws
  servername: mmx.vpnoir9r.us.kg
  ws-opts:
    path: /sgoracle
    headers:
      Host: mmx.vpnoir9r.us.kg</textarea>
 </div>
<div style="display: none;">
   <textarea id="clashNtls/sgoracle">- name: Oracle Corporation (SG)
  server: mmx.vpnoir9r.us.kg
  port: 80
  type: vless
  uuid: 4658af9f-5cbf-4310-ab89-935c9a940c85
  cipher: auto
  tls: false
  udp: true
  skip-cert-verify: true
  network: ws
  ws-opts:
    path: /sgoracle
    headers:
      Host: mmx.vpnoir9r.us.kg</textarea>
 </div>
<div class="config-section">
    <p><strong>ISP  :  Oracle Corporation (SG)</strong> </p>
    <hr/>
    <div class="config-toggle">
        <button class="button" onclick="toggleConfig(this, 'show clash', 'hide clash')">Show Clash</button>
        <div class="config-content">
            <div class="config-block">
                <h3>TLS:</h3>
                <p class="config">- name: Oracle Corporation (SG)
  server: mmx.vpnoir9r.us.kg
  port: 443
  type: vless
  uuid: 4f60261d-48f3-41a0-9050-5d1e261619a7
  cipher: auto
  tls: true
  udp: true
  skip-cert-verify: true
  network: ws
  servername: mmx.vpnoir9r.us.kg
  ws-opts:
    path: /sgoracle
    headers:
      Host: mmx.vpnoir9r.us.kg</p>
                <button class="button" onclick='copyClash("clashTls/sgoracle")'><i class="fa fa-clipboard"></i>Copy</button>
            </div>
            <hr />
            <div class="config-block">
                <h3>NTLS:</h3>
                <p class="config">- name: Oracle Corporation (SG)
  server: mmx.vpnoir9r.us.kg
  port: 80
  type: vless
  uuid: 4658af9f-5cbf-4310-ab89-935c9a940c85
  cipher: auto
  tls: false
  udp: true
  skip-cert-verify: true
  network: ws
  ws-opts:
    path: /sgoracle
    headers:
      Host: mmx.vpnoir9r.us.kg</p>
                <button class="button" onclick='copyClash("clashNtls/sgoracle")'><i class="fa fa-clipboard"></i>Copy</button>
            </div>
        </div>
    </div>
</div>
<hr class="config-divider" />
<div style="display: none;">
   <textarea id="clashTls/sgaryaka">- name: Aryaka Networks, Inc. (SG)
  server: mmx.vpnoir9r.us.kg
  port: 443
  type: vless
  uuid: a6f5e712-6811-4b0a-ac46-2906cb66bb73
  cipher: auto
  tls: true
  udp: true
  skip-cert-verify: true
  network: ws
  servername: mmx.vpnoir9r.us.kg
  ws-opts:
    path: /sgaryaka
    headers:
      Host: mmx.vpnoir9r.us.kg</textarea>
 </div>
<div style="display: none;">
   <textarea id="clashNtls/sgaryaka">- name: Aryaka Networks, Inc. (SG)
  server: mmx.vpnoir9r.us.kg
  port: 80
  type: vless
  uuid: ccec1971-fcc9-4c67-b2cd-e9c1ce93f372
  cipher: auto
  tls: false
  udp: true
  skip-cert-verify: true
  network: ws
  ws-opts:
    path: /sgaryaka
    headers:
      Host: mmx.vpnoir9r.us.kg</textarea>
 </div>
<div class="config-section">
    <p><strong>ISP  :  Aryaka Networks, Inc. (SG)</strong> </p>
    <hr/>
    <div class="config-toggle">
        <button class="button" onclick="toggleConfig(this, 'show clash', 'hide clash')">Show Clash</button>
        <div class="config-content">
            <div class="config-block">
                <h3>TLS:</h3>
                <p class="config">- name: Aryaka Networks, Inc. (SG)
  server: mmx.vpnoir9r.us.kg
  port: 443
  type: vless
  uuid: a6f5e712-6811-4b0a-ac46-2906cb66bb73
  cipher: auto
  tls: true
  udp: true
  skip-cert-verify: true
  network: ws
  servername: mmx.vpnoir9r.us.kg
  ws-opts:
    path: /sgaryaka
    headers:
      Host: mmx.vpnoir9r.us.kg</p>
                <button class="button" onclick='copyClash("clashTls/sgaryaka")'><i class="fa fa-clipboard"></i>Copy</button>
            </div>
            <hr />
            <div class="config-block">
                <h3>NTLS:</h3>
                <p class="config">- name: Aryaka Networks, Inc. (SG)
  server: mmx.vpnoir9r.us.kg
  port: 80
  type: vless
  uuid: ccec1971-fcc9-4c67-b2cd-e9c1ce93f372
  cipher: auto
  tls: false
  udp: true
  skip-cert-verify: true
  network: ws
  ws-opts:
    path: /sgaryaka
    headers:
      Host: mmx.vpnoir9r.us.kg</p>
                <button class="button" onclick='copyClash("clashNtls/sgaryaka")'><i class="fa fa-clipboard"></i>Copy</button>
            </div>
        </div>
    </div>
</div>
<hr class="config-divider" />
<div style="display: none;">
   <textarea id="clashTls/sgbelnet">- name: First Server Limited (SG)
  server: mmx.vpnoir9r.us.kg
  port: 443
  type: vless
  uuid: b11c6d39-7938-4222-887b-fe26e867c4b8
  cipher: auto
  tls: true
  udp: true
  skip-cert-verify: true
  network: ws
  servername: mmx.vpnoir9r.us.kg
  ws-opts:
    path: /sgbelnet
    headers:
      Host: mmx.vpnoir9r.us.kg</textarea>
 </div>
<div style="display: none;">
   <textarea id="clashNtls/sgbelnet">- name: First Server Limited (SG)
  server: mmx.vpnoir9r.us.kg
  port: 80
  type: vless
  uuid: 0bc86f77-1758-4012-b263-0bb8f1058e5e
  cipher: auto
  tls: false
  udp: true
  skip-cert-verify: true
  network: ws
  ws-opts:
    path: /sgbelnet
    headers:
      Host: mmx.vpnoir9r.us.kg</textarea>
 </div>
<div class="config-section">
    <p><strong>ISP  :  First Server Limited (SG)</strong> </p>
    <hr/>
    <div class="config-toggle">
        <button class="button" onclick="toggleConfig(this, 'show clash', 'hide clash')">Show Clash</button>
        <div class="config-content">
            <div class="config-block">
                <h3>TLS:</h3>
                <p class="config">- name: First Server Limited (SG)
  server: mmx.vpnoir9r.us.kg
  port: 443
  type: vless
  uuid: b11c6d39-7938-4222-887b-fe26e867c4b8
  cipher: auto
  tls: true
  udp: true
  skip-cert-verify: true
  network: ws
  servername: mmx.vpnoir9r.us.kg
  ws-opts:
    path: /sgbelnet
    headers:
      Host: mmx.vpnoir9r.us.kg</p>
                <button class="button" onclick='copyClash("clashTls/sgbelnet")'><i class="fa fa-clipboard"></i>Copy</button>
            </div>
            <hr />
            <div class="config-block">
                <h3>NTLS:</h3>
                <p class="config">- name: First Server Limited (SG)
  server: mmx.vpnoir9r.us.kg
  port: 80
  type: vless
  uuid: 0bc86f77-1758-4012-b263-0bb8f1058e5e
  cipher: auto
  tls: false
  udp: true
  skip-cert-verify: true
  network: ws
  ws-opts:
    path: /sgbelnet
    headers:
      Host: mmx.vpnoir9r.us.kg</p>
                <button class="button" onclick='copyClash("clashNtls/sgbelnet")'><i class="fa fa-clipboard"></i>Copy</button>
            </div>
        </div>
    </div>
</div>
<hr class="config-divider" />
<div style="display: none;">
   <textarea id="clashTls/sgamazon">- name: Amazon.com, Inc. (SG)
  server: mmx.vpnoir9r.us.kg
  port: 443
  type: vless
  uuid: 97e8e7fe-0df3-4e28-9358-43b4744d4361
  cipher: auto
  tls: true
  udp: true
  skip-cert-verify: true
  network: ws
  servername: mmx.vpnoir9r.us.kg
  ws-opts:
    path: /sgamazon
    headers:
      Host: mmx.vpnoir9r.us.kg</textarea>
 </div>
<div style="display: none;">
   <textarea id="clashNtls/sgamazon">- name: Amazon.com, Inc. (SG)
  server: mmx.vpnoir9r.us.kg
  port: 80
  type: vless
  uuid: e42c40e3-5ff0-464c-b6a5-7785b3026ac9
  cipher: auto
  tls: false
  udp: true
  skip-cert-verify: true
  network: ws
  ws-opts:
    path: /sgamazon
    headers:
      Host: mmx.vpnoir9r.us.kg</textarea>
 </div>
<div class="config-section">
    <p><strong>ISP  :  Amazon.com, Inc. (SG)</strong> </p>
    <hr/>
    <div class="config-toggle">
        <button class="button" onclick="toggleConfig(this, 'show clash', 'hide clash')">Show Clash</button>
        <div class="config-content">
            <div class="config-block">
                <h3>TLS:</h3>
                <p class="config">- name: Amazon.com, Inc. (SG)
  server: mmx.vpnoir9r.us.kg
  port: 443
  type: vless
  uuid: 97e8e7fe-0df3-4e28-9358-43b4744d4361
  cipher: auto
  tls: true
  udp: true
  skip-cert-verify: true
  network: ws
  servername: mmx.vpnoir9r.us.kg
  ws-opts:
    path: /sgamazon
    headers:
      Host: mmx.vpnoir9r.us.kg</p>
                <button class="button" onclick='copyClash("clashTls/sgamazon")'><i class="fa fa-clipboard"></i>Copy</button>
            </div>
            <hr />
            <div class="config-block">
                <h3>NTLS:</h3>
                <p class="config">- name: Amazon.com, Inc. (SG)
  server: mmx.vpnoir9r.us.kg
  port: 80
  type: vless
  uuid: e42c40e3-5ff0-464c-b6a5-7785b3026ac9
  cipher: auto
  tls: false
  udp: true
  skip-cert-verify: true
  network: ws
  ws-opts:
    path: /sgamazon
    headers:
      Host: mmx.vpnoir9r.us.kg</p>
                <button class="button" onclick='copyClash("clashNtls/sgamazon")'><i class="fa fa-clipboard"></i>Copy</button>
            </div>
        </div>
    </div>
</div>
<hr class="config-divider" />

        </div>
    </div>
    <script data-cfasync="false" src="/cdn-cgi/scripts/5c5dd728/cloudflare-static/email-decode.min.js"></script><script>
        function showContent(contentId) {
            const contents = document.querySelectorAll('.content');
            contents.forEach(content => {
                content.classList.remove('active');
            });
            document.getElementById(contentId).classList.add('active');
        }
        function salinTeks() {
            var teks = document.getElementById('teksAsli');
            teks.select();
            document.execCommand('copy');
            alert('Teks telah disalin.');
        }
        function copyClash(elementId) {
            const text = document.getElementById(elementId).textContent;
            navigator.clipboard.writeText(text)
            .then(() => {
            const alertBox = document.createElement('div');
            alertBox.textContent = "Copied to clipboard!";
            alertBox.style.position = 'fixed';
            alertBox.style.bottom = '20px';
            alertBox.style.right = '20px';
            alertBox.style.backgroundColor = 'yellow';
            alertBox.style.color = '#fff';
            alertBox.style.padding = '10px 20px';
            alertBox.style.borderRadius = '5px';
            alertBox.style.boxShadow = '0 4px 6px rgba(0,0,0,0.1)';
            alertBox.style.opacity = '0';
            alertBox.style.transition = 'opacity 0.5s ease-in-out';
            document.body.appendChild(alertBox);
            setTimeout(() => {
                alertBox.style.opacity = '1';
            }, 100);
            setTimeout(() => {
                alertBox.style.opacity = '0';
                setTimeout(() => {
                    document.body.removeChild(alertBox);
                }, 500);
            }, 2000);
        })
        .catch((err) => {
            console.error("Failed to copy to clipboard:", err);
        });
        }
function fetchAndDisplayAlert(path) {
    fetch(path)
        .then(response => {
            if (!response.ok) {
                throw new Error(`HTTP error! Status: ${response.status}`);
            }
            return response.json();
        })
        .then(data => {
            const proxyStatus = data.proxyStatus || "Unknown status";
            const alertBox = document.createElement('div');
            alertBox.textContent = `Proxy Status: ${proxyStatus}`;
            alertBox.style.position = 'fixed';
            alertBox.style.bottom = '20px';
            alertBox.style.right = '20px';
            alertBox.style.backgroundColor = 'yellow';
            alertBox.style.color = '#fff';
            alertBox.style.padding = '10px 20px';
            alertBox.style.borderRadius = '5px';
            alertBox.style.boxShadow = '0 4px 6px rgba(0,0,0,0.1)';
            alertBox.style.opacity = '0';
            alertBox.style.transition = 'opacity 0.5s ease-in-out';
            document.body.appendChild(alertBox);
            
            setTimeout(() => {
                alertBox.style.opacity = '1';
            }, 100);
            
            setTimeout(() => {
                alertBox.style.opacity = '0';
                setTimeout(() => {
                    document.body.removeChild(alertBox);
                }, 500);
            }, 2000);
        })
        .catch((err) => {
            alert("Failed to fetch data or invalid response.");
        });
}
        function copyToClipboard(text) {
            navigator.clipboard.writeText(text)
                .then(() => {
                    const alertBox = document.createElement('div');
                    alertBox.textContent = "Copied to clipboard!";
                    alertBox.style.position = 'fixed';
                    alertBox.style.bottom = '20px';
                    alertBox.style.right = '20px';
                    alertBox.style.backgroundColor = 'yellow';
                    alertBox.style.color = '#fff';
                    alertBox.style.padding = '10px 20px';
                    alertBox.style.borderRadius = '5px';
                    alertBox.style.boxShadow = '0 4px 6px rgba(0,0,0,0.1)';
                    alertBox.style.opacity = '0';
                    alertBox.style.transition = 'opacity 0.5s ease-in-out';
                    document.body.appendChild(alertBox);
                    setTimeout(() => {
                        alertBox.style.opacity = '1';
                    }, 100);
                    setTimeout(() => {
                        alertBox.style.opacity = '0';
                        setTimeout(() => {
                            document.body.removeChild(alertBox);
                        }, 500);
                    }, 2000);
                })
                .catch((err) => {
                    console.error("Failed to copy to clipboard:", err);
                });
        }

        function toggleConfig(button, show, hide) {
            const configContent = button.nextElementSibling;
            if (configContent.classList.contains('active')) {
                configContent.classList.remove('active');
                button.textContent = show;
            } else {
                configContent.classList.add('active');
                button.textContent = hide;
            }
        }
    </script>
</body>
</html>
`;
}
