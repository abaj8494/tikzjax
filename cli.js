#!/usr/bin/env node
/**
 * tikzjax CLI - Render TikZ LaTeX to SVG via WebAssembly
 *
 * Usage: echo '\begin{tikzpicture}...\end{tikzpicture}' | node cli.js > output.svg
 *        node cli.js < input.tex > output.svg
 */

const fs = require('fs');
const path = require('path');
const pako = require('pako');
const { Writable } = require('stream');

// Import dvi2html - this converts DVI to SVG/HTML
let dvi2html, tfmData;
try {
    const dvi2htmlModule = require('dvi2html');
    dvi2html = dvi2htmlModule.dvi2html;
    tfmData = dvi2htmlModule.tfmData;
} catch (e) {
    console.error('Error: dvi2html not found. Run "npm install" in the tikzjax directory.');
    process.exit(1);
}

const TIKZJAX_DIR = __dirname;

// Library state (adapted from library.ts)
let filesystem = {};
let files = [];
let memory = null;
let inputBuffer = null;
let wasmExports = null;
let view = null;
let finished = null;
const pages = 1100;
const DATA_ADDR = (pages - 100) * 1024 * 64;
const END_ADDR = pages * 1024 * 64;
let windingDepth = 0;
let sleeping = false;

function deferredPromise() {
    let _resolve, _reject;
    let promise = new Promise((resolve, reject) => {
        _resolve = resolve;
        _reject = reject;
    });
    promise.resolve = _resolve;
    promise.reject = _reject;
    return promise;
}

function deleteEverything() {
    files = [];
    filesystem = {};
    memory = null;
    inputBuffer = null;
    finished = null;
    wasmExports = null;
    view = null;
    sleeping = false;
}

function writeFileSync(filename, buffer) {
    filesystem[filename] = buffer;
}

function readFileSync(filename) {
    for (let f of files) {
        if (f.filename === filename && f.content) {
            return f.content.slice(0, f.position);
        }
    }
    throw Error(`Could not find file ${filename}`);
}

function loadTexFile(filename) {
    const filePath = path.join(TIKZJAX_DIR, 'tex_files', `${filename}.gz`);
    if (fs.existsSync(filePath)) {
        const gzipped = fs.readFileSync(filePath);
        return pako.ungzip(gzipped);
    }
    return null;
}

function openSync(filename, mode) {
    let buffer = new Uint8Array();

    if (filesystem[filename]) {
        buffer = filesystem[filename];
    } else if (filename.match(/\.tfm$/)) {
        buffer = Uint8Array.from(tfmData(filename.replace(/\.tfm$/, '')));
    } else if (mode === 'r') {
        // Check if file was written to before
        let descriptor = files.findIndex(element => element.filename === filename && !element.erstat);
        if (descriptor === -1) {
            // Try to load from tex_files
            const loaded = loadTexFile(filename);
            if (loaded) {
                filesystem[filename] = loaded;
                buffer = loaded;
            } else if (filename.match(/\.(aux|log|dvi)$/)) {
                files.push({ filename, erstat: 1 });
                return files.length - 1;
            } else {
                files.push({ filename, erstat: 1 });
                return files.length - 1;
            }
        }
    }

    files.push({
        filename,
        position: 0,
        position2: 0,
        erstat: 0,
        eoln: false,
        content: buffer,
        descriptor: files.length
    });

    return files.length - 1;
}

function writeSync(file, buffer, pointer, length) {
    if (pointer === undefined) pointer = 0;
    if (length === undefined) length = buffer.length - pointer;

    while (length > file.content.length - file.position) {
        let b = new Uint8Array(1 + file.content.length * 2);
        b.set(file.content);
        file.content = b;
    }

    file.content.subarray(file.position).set(buffer.subarray(pointer, pointer + length));
    file.position += length;
}

function readSync(file, buffer, pointer, length, seek) {
    if (pointer === undefined) pointer = 0;
    if (length === undefined) length = buffer.length - pointer;

    if (length > file.content.length - seek)
        length = file.content.length - seek;

    buffer.subarray(pointer).set(file.content.subarray(seek, seek + length));
    return length;
}

// Library exports for WASM
const library = {
    getCurrentMinutes: () => {
        const d = new Date();
        return 60 * d.getHours() + d.getMinutes();
    },
    getCurrentDay: () => new Date().getDate(),
    getCurrentMonth: () => new Date().getMonth() + 1,
    getCurrentYear: () => new Date().getFullYear(),

    printString: (descriptor, x) => {
        const length = new Uint8Array(memory.buffer, x, 1)[0];
        const buffer = new Uint8Array(memory.buffer, x + 1, length);
        const string = String.fromCharCode.apply(null, buffer);
        if (descriptor < 0) return; // stdout - ignore for CLI
        const file = files[descriptor];
        if (file && file.content !== undefined) writeSync(file, Buffer.from(string));
    },

    printBoolean: (descriptor, x) => {
        const result = x ? "TRUE" : "FALSE";
        if (descriptor < 0) return;
        const file = files[descriptor];
        if (file && file.content !== undefined) writeSync(file, Buffer.from(result));
    },

    printChar: (descriptor, x) => {
        if (descriptor < 0) return;
        const file = files[descriptor];
        if (file && file.content !== undefined) {
            const b = Buffer.alloc(1);
            b[0] = x;
            writeSync(file, b);
        }
    },

    printInteger: (descriptor, x) => {
        if (descriptor < 0) return;
        const file = files[descriptor];
        if (file && file.content !== undefined) writeSync(file, Buffer.from(x.toString()));
    },

    printFloat: (descriptor, x) => {
        if (descriptor < 0) return;
        const file = files[descriptor];
        if (file && file.content !== undefined) writeSync(file, Buffer.from(x.toString()));
    },

    printNewline: (descriptor) => {
        if (descriptor < 0) return;
        const file = files[descriptor];
        if (file && file.content !== undefined) writeSync(file, Buffer.from("\n"));
    },

    reset: (length, pointer) => {
        const buffer = new Uint8Array(memory.buffer, pointer, length);
        let filename = String.fromCharCode.apply(null, buffer);

        filename = filename.replace(/\000+$/g, '');
        if (filename.startsWith('{')) {
            filename = filename.replace(/^{/g, '').replace(/}.*/g, '');
        }
        if (filename.startsWith('"')) {
            filename = filename.replace(/^"/g, '').replace(/".*/g, '');
        }
        filename = filename.replace(/ +$/g, '').replace(/^\*/, '').replace(/^TeXfonts:/, '');

        if (filename === 'TeXformats:TEX.POOL') filename = "tex.pool";

        if (filename === "TTY:") {
            files.push({
                filename: "stdin",
                stdin: true,
                position: 0,
                position2: 0,
                erstat: 0,
                eoln: false,
                content: Buffer.from(inputBuffer)
            });
            return files.length - 1;
        }

        return openSync(filename, 'r');
    },

    rewrite: (length, pointer) => {
        const buffer = new Uint8Array(memory.buffer, pointer, length);
        let filename = String.fromCharCode.apply(null, buffer);

        filename = filename.replace(/ +$/g, '');
        if (filename.startsWith('"')) {
            filename = filename.replace(/^"/g, '').replace(/".*/g, '');
        }

        if (filename === "TTY:") {
            files.push({ filename: "stdout", stdout: true, erstat: 0 });
            return files.length - 1;
        }

        return openSync(filename, 'w');
    },

    close: (descriptor) => { /* ignore */ },

    eof: (descriptor) => {
        const file = files[descriptor];
        return file && file.eof ? 1 : 0;
    },

    erstat: (descriptor) => {
        const file = files[descriptor];
        return file ? file.erstat : 1;
    },

    eoln: (descriptor) => {
        const file = files[descriptor];
        return file && file.eoln ? 1 : 0;
    },

    inputln: (descriptor, bypass_eoln, bufferp, firstp, lastp, max_buf_stackp, buf_size) => {
        const file = files[descriptor];
        const buffer = new Uint8Array(memory.buffer, bufferp, buf_size);
        const first = new Uint32Array(memory.buffer, firstp, 4);
        const last = new Uint32Array(memory.buffer, lastp, 4);

        last[0] = first[0];

        if (bypass_eoln && !file.eof && file.eoln) {
            file.position2 = file.position2 + 1;
        }

        let endOfLine = file.content.indexOf(10, file.position2);
        if (endOfLine < 0) endOfLine = file.content.length;

        if (file.position2 >= file.content.length) {
            if (file.stdin) {
                library.tex_final_end();
            }
            file.eof = true;
            return false;
        } else {
            buffer.subarray(first[0]).set(file.content.subarray(file.position2, endOfLine));
            last[0] = first[0] + endOfLine - file.position2;

            while (buffer[last[0] - 1] === 32) last[0] = last[0] - 1;

            file.position2 = endOfLine;
            file.eoln = true;
        }

        return true;
    },

    get: (descriptor, pointer, length) => {
        const file = files[descriptor];
        const buffer = new Uint8Array(memory.buffer);

        if (file.stdin) {
            if (file.position >= inputBuffer.length) {
                buffer[pointer] = 13;
                file.eof = true;
                library.tex_final_end();
            } else {
                buffer[pointer] = inputBuffer[file.position].charCodeAt(0);
            }
        } else {
            if (file.descriptor !== undefined) {
                if (readSync(file, buffer, pointer, length, file.position) === 0) {
                    buffer[pointer] = 0;
                    file.eof = true;
                    file.eoln = true;
                    return;
                }
            } else {
                file.eof = true;
                file.eoln = true;
                return;
            }
        }

        file.eoln = false;
        if (buffer[pointer] === 10) file.eoln = true;
        if (buffer[pointer] === 13) file.eoln = true;

        file.position = file.position + length;
    },

    put: (descriptor, pointer, length) => {
        const file = files[descriptor];
        const buffer = new Uint8Array(memory.buffer);
        writeSync(file, buffer, pointer, length);
    },

    tex_final_end: () => {
        if (finished) finished.resolve();
    }
};

async function runTex() {
    // Load WASM and coredump
    const wasmPath = path.join(TIKZJAX_DIR, 'tex.wasm.gz');
    const coredumpPath = path.join(TIKZJAX_DIR, 'core.dump.gz');

    if (!fs.existsSync(wasmPath) || !fs.existsSync(coredumpPath)) {
        throw new Error('tex.wasm.gz or core.dump.gz not found in tikzjax directory');
    }

    const code = pako.ungzip(fs.readFileSync(wasmPath));
    const coredump = pako.ungzip(fs.readFileSync(coredumpPath));

    // inputBuffer and input.tex should already be set by caller

    // Set up WASM memory
    memory = new WebAssembly.Memory({ initial: pages, maximum: pages });
    const buffer = new Uint8Array(memory.buffer, 0, pages * 65536);
    buffer.set(coredump.slice(0, pages * 65536));

    view = new Int32Array(memory.buffer);

    // Instantiate WASM
    const wasm = await WebAssembly.instantiate(code, {
        library: library,
        env: { memory: memory }
    });

    wasmExports = wasm.instance.exports;
    finished = deferredPromise();

    // Run TeX
    wasmExports.main();
    wasmExports.asyncify_stop_unwind();

    await finished;

    // Check for errors in log
    try {
        const log = readFileSync("input.log");
        const logStr = Buffer.from(log).toString();
        if (logStr.includes('!') || logStr.includes('Emergency stop')) {
            console.error("=== TeX Log (errors) ===");
            // Extract error lines
            const lines = logStr.split('\n');
            let inError = false;
            for (const line of lines) {
                if (line.startsWith('!') || inError) {
                    console.error(line);
                    inError = true;
                    if (line === '' && inError) inError = false;
                }
            }
        }
    } catch (e) {
        // No log file
    }

    // Extract DVI
    const dvi = readFileSync("input.dvi").buffer;

    // Clean up
    deleteEverything();

    return dvi;
}

async function dviToSvg(dvi) {
    let html = "";
    const page = new Writable({
        write(chunk, encoding, callback) {
            html = html + chunk.toString();
            callback();
        }
    });

    async function* streamBuffer() {
        yield Buffer.from(dvi);
        return;
    }

    await dvi2html(streamBuffer(), page);

    // Fix soft hyphen issue (same as in index.ts)
    html = html.replaceAll("&#173;", "&#172;");

    // Ensure SVG has closing tag (dvi2html sometimes omits it)
    if (html.includes("<svg") && !html.includes("</svg>")) {
        html = html + "</svg>";
    }

    return html;
}

async function main() {
    // Read input from stdin
    const chunks = [];
    for await (const chunk of process.stdin) {
        chunks.push(chunk);
    }
    let rawBuffer = Buffer.concat(chunks);
    let texInput = rawBuffer.toString('utf-8');

    // Strip UTF-8 BOM if present
    if (texInput.charCodeAt(0) === 0xFEFF) {
        texInput = texInput.slice(1);
    }
    // Strip any null bytes that might have been introduced
    texInput = texInput.replace(/\x00/g, '');

    if (!texInput.trim()) {
        console.error('Usage: echo "\\begin{tikzpicture}...\\end{tikzpicture}" | node cli.js');
        process.exit(1);
    }

    try {
        // Write the TeX content to input.tex, then run TeX with command to process it
        writeFileSync("input.tex", Buffer.from(texInput));
        inputBuffer = " input.tex \n\\end\n";  // TeX command to process input.tex

        const dvi = await runTex();
        const svg = await dviToSvg(dvi);
        process.stdout.write(svg);
    } catch (err) {
        console.error('Error:', err.message || err);
        process.exit(1);
    }
}

main();
