
/**
 * Body.js
 *
 * Body interface provides common methods for Request and Response
 */

import Stream, {finished, PassThrough} from 'stream';
import {types} from 'util';

import Blob from 'fetch-blob';
import FetchError from './errors/fetch-error.js';
import {isBlob, isURLSearchParameters, isAbortError} from './utils/is.js';

const INTERNALS = Symbol('Body internals');

/**
 * Body mixin
 *
 * Ref: https://fetch.spec.whatwg.org/#body
 *
 * @param   Stream  body  Readable stream
 * @param   Object  opts  Response options
 * @return  Void
 */
export default class Body {
	constructor(body, {
		size = 0,
		timeout = 0
	} = {}) {
		if (body === null) {
		// Body is undefined or null
			body = null;
		} else if (isURLSearchParameters(body)) {
		// Body is a URLSearchParams
			body = Buffer.from(body.toString());
		} else if (isBlob(body)) {
		// Body is blob
		} else if (Buffer.isBuffer(body)) {
		// Body is Buffer
		} else if (types.isAnyArrayBuffer(body)) {
		// Body is ArrayBuffer
			body = Buffer.from(body);
		} else if (ArrayBuffer.isView(body)) {
		// Body is ArrayBufferView
			body = Buffer.from(body.buffer, body.byteOffset, body.byteLength);
		} else if (body instanceof Stream) {
		// Body is stream
		} else {
		// None of the above
		// coerce to string then buffer
			body = Buffer.from(String(body));
		}

		this[INTERNALS] = {
			body,
			disturbed: false,
			error: null
		};
		this.size = size;
		this.timeout = timeout;

		if (body instanceof Stream) {
			body.on('error', err => {
				const error = isAbortError(err) ?
					err :
					new FetchError(`Invalid response body while trying to fetch ${this.url}: ${err.message}`, 'system', err);
				this[INTERNALS].error = error;
			});
		}
	}

	get body() {
		return this[INTERNALS].body;
	}

	get bodyUsed() {
		return this[INTERNALS].disturbed;
	}

	/**
	 * Decode response as ArrayBuffer
	 *
	 * @return  Promise
	 */
	async arrayBuffer() {
		const {buffer, byteOffset, byteLength} = await consumeBody(this);
		return buffer.slice(byteOffset, byteOffset + byteLength);
	}

	/**
	 * Return raw response as Blob
	 *
	 * @return Promise
	 */
	async blob() {
		const ct = this.headers && this.headers.get('content-type') || this[INTERNALS].body && this[INTERNALS].body.type || '';
		const buf = await consumeBody(this);

		return new Blob([], {
			type: ct.toLowerCase(),
			buffer: buf
		});
	}

	/**
	 * Decode response as json
	 *
	 * @return  Promise
	 */
	async json() {
		const buffer = await consumeBody(this);
		return JSON.parse(buffer.toString());
	}

	/**
	 * Decode response as text
	 *
	 * @return  Promise
	 */
	async text() {
		const buffer = await consumeBody(this);
		return buffer.toString();
	}

	/**
	 * Decode response as buffer (non-spec api)
	 *
	 * @return  Promise
	 */
	buffer() {
		return consumeBody(this);
	}
}

// In browsers, all properties are enumerable.
Object.defineProperties(Body.prototype, {
	body: {enumerable: true},
	bodyUsed: {enumerable: true},
	arrayBuffer: {enumerable: true},
	blob: {enumerable: true},
	json: {enumerable: true},
	text: {enumerable: true}
});

/**
 * Consume and convert an entire Body to a Buffer.
 *
 * Ref: https://fetch.spec.whatwg.org/#concept-body-consume-body
 *
 * @return  Promise
 */
const consumeBody = data => {
	if (data[INTERNALS].disturbed) {
		return Body.Promise.reject(new TypeError(`body used already for: ${data.url}`));
	}

	data[INTERNALS].disturbed = true;

	if (data[INTERNALS].error) {
		return Body.Promise.reject(data[INTERNALS].error);
	}

	let {body} = data;

	// Body is null
	if (body === null) {
		return Body.Promise.resolve(Buffer.alloc(0));
	}

	// Body is blob
	if (isBlob(body)) {
		body = body.stream();
	}

	// Body is buffer
	if (Buffer.isBuffer(body)) {
		return Body.Promise.resolve(body);
	}

	// istanbul ignore if: should never happen
	if (!(body instanceof Stream)) {
		return Body.Promise.resolve(Buffer.alloc(0));
	}

	// Body is stream
	// get ready to actually consume the body
	const accum = [];
	let accumBytes = 0;
	let abort = false;

	return new Body.Promise((resolve, reject) => {
		let responseTimeout;

		// Allow timeout on slow response body
		if (data.timeout) {
			responseTimeout = setTimeout(() => {
				abort = true;
				const err = new FetchError(`Response timeout while trying to fetch ${data.url} (over ${data.timeout}ms)`, 'body-timeout');
				reject(err);
				body.destroy(err);
			}, data.timeout);
		}

		body.on('data', chunk => {
			if (abort || chunk === null) {
				return;
			}

			if (data.size && accumBytes + chunk.length > data.size) {
				abort = true;
				reject(new FetchError(`content size at ${data.url} over limit: ${data.size}`, 'max-size'));
				return;
			}

			accumBytes += chunk.length;
			accum.push(chunk);
		});

		finished(body, {writable: false}, err => {
			clearTimeout(responseTimeout);
			if (err) {
				if (isAbortError(err)) {
					// If the request was aborted, reject with this Error
					abort = true;
					reject(err);
				} else {
					// Other errors, such as incorrect content-encoding
					reject(new FetchError(`Invalid response body while trying to fetch ${data.url}: ${err.message}`, 'system', err));
				}
			} else {
				if (abort) {
					return;
				}

				try {
					resolve(Buffer.concat(accum, accumBytes));
				} catch (error) {
					// Handle streams that have accumulated too much data (issue #414)
					reject(new FetchError(`Could not create Buffer from response body for ${data.url}: ${error.message}`, 'system', error));
				}
			}
		});
	});
};

/**
 * Clone body given Res/Req instance
 *
 * @param   Mixed   instance       Response or Request instance
 * @param   String  highWaterMark  highWaterMark for both PassThrough body streams
 * @return  Mixed
 */
export const clone = (instance, highWaterMark) => {
	let p1;
	let p2;
	let {body} = instance;

	// Don't allow cloning a used body
	if (instance.bodyUsed) {
		throw new Error('cannot clone body after it is used');
	}

	// Check that body is a stream and not form-data object
	// note: we can't clone the form-data object without having it as a dependency
	if ((body instanceof Stream) && (typeof body.getBoundary !== 'function')) {
		// Tee instance body
		p1 = new PassThrough({highWaterMark});
		p2 = new PassThrough({highWaterMark});
		body.pipe(p1);
		body.pipe(p2);
		// Set instance body to teed body and return the other teed body
		instance[INTERNALS].body = p1;
		body = p2;
	}

	return body;
};

/**
 * Performs the operation "extract a `Content-Type` value from |object|" as
 * specified in the specification:
 * https://fetch.spec.whatwg.org/#concept-bodyinit-extract
 *
 * This function assumes that instance.body is present.
 *
 * @param {any} body Any options.body input
 * @returns {string | null}
 */
export const extractContentType = body => {
	// Body is null or undefined
	if (body === null) {
		return null;
	}

	// Body is string
	if (typeof body === 'string') {
		return 'text/plain;charset=UTF-8';
	}

	// Body is a URLSearchParams
	if (isURLSearchParameters(body)) {
		return 'application/x-www-form-urlencoded;charset=UTF-8';
	}

	// Body is blob
	if (isBlob(body)) {
		return body.type || null;
	}

	// Body is a Buffer (Buffer, ArrayBuffer or ArrayBufferView)
	if (Buffer.isBuffer(body) || types.isAnyArrayBuffer(body) || ArrayBuffer.isView(body)) {
		return null;
	}

	// Detect form data input from form-data module
	if (body && typeof body.getBoundary === 'function') {
		return `multipart/form-data;boundary=${body.getBoundary()}`;
	}

	// Body is stream - can't really do much about this
	if (body instanceof Stream) {
		return null;
	}

	// Body constructor defaults other things to string
	return 'text/plain;charset=UTF-8';
};

/**
 * The Fetch Standard treats this as if "total bytes" is a property on the body.
 * For us, we have to explicitly get it with a function.
 *
 * ref: https://fetch.spec.whatwg.org/#concept-body-total-bytes
 *
 * @param {any} obj.body Body object from the Body instance.
 * @returns {number | null}
 */
export const getTotalBytes = ({body}) => {
	// Body is null or undefined
	if (body === null) {
		return 0;
	}

	// Body is Blob
	if (isBlob(body)) {
		return body.size;
	}

	// Body is Buffer
	if (Buffer.isBuffer(body)) {
		return body.length;
	}

	// Detect form data input from form-data module
	if (body && typeof body.getLengthSync === 'function') {
		return body.hasKnownLength && body.hasKnownLength() ? body.getLengthSync() : null;
	}

	// Body is stream
	return null;
};

/**
 * Write a Body to a Node.js WritableStream (e.g. http.Request) object.
 *
 * @param {Stream.Writable} dest The stream to write to.
 * @param obj.body Body object from the Body instance.
 * @returns {void}
 */
export const writeToStream = (dest, {body}) => {
	if (body === null) {
		// Body is null
		dest.end();
	} else if (isBlob(body)) {
		// Body is Blob
		body.stream().pipe(dest);
	} else if (Buffer.isBuffer(body)) {
		// Body is buffer
		dest.write(body);
		dest.end();
	} else {
		// Body is stream
		body.pipe(dest);
	}
};

// Expose Promise
Body.Promise = global.Promise;
