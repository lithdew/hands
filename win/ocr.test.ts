import { describe, expect, test } from "bun:test";
import { createOcr, parseReply, unite, type OcrProcess } from "./ocr";

describe("parseReply", () => {
  test("PowerShell 5.1 writes a one-element array as the element: a line with one word still has words", () => {
    const reply = parseReply('{"ms":110,"lang":"en-US","scale":2,"width":1280,"height":800,"lines":{"text":"Save","words":{"t":"Save","x":283,"y":61.5,"w":29,"h":10}}}');
    expect(reply.lines).toEqual([{ text: "Save", words: [{ t: "Save", x: 283, y: 61.5, w: 29, h: 10 }] }]);
    expect(parseReply('{"ms":3,"lang":"en-US","lines":null}').lines).toEqual([]);
  });
  test("an engine error is an error here", () => {
    expect(() => parseReply('{"error":"no OCR language is installed"}')).toThrow("no OCR language");
  });
});

describe("unite", () => {
  test("the enlarged pass wins where both read something; what only the plain pass saw is added", () => {
    const fine = [{ text: "GUESTS", words: [{ t: "GUESTS", x: 689, y: 197, w: 48, h: 10 }] }];
    const plain = [{ text: "GU ESTS", words: [{ t: "GU", x: 689, y: 197, w: 16, h: 10 }, { t: "ESTS", x: 708, y: 197, w: 29, h: 10 }] }, { text: "7:30 PM 8:15 PM", words: [{ t: "7:30", x: 972, y: 303, w: 28, h: 11 }, { t: "PM", x: 1004, y: 303, w: 20, h: 11 }] }];
    expect(unite(fine, plain).map((l) => l.text)).toEqual(["GUESTS", "7:30 PM"]);
  });
});

describe("createOcr", () => {
  function fake(replies: string[]) {
    const written: string[] = [];
    let push!: (line: string) => void;
    const stdout = new ReadableStream<Uint8Array>({ start(controller) { push = (line) => controller.enqueue(new TextEncoder().encode(`${line}\r\n`)); } });
    const proc: OcrProcess = { stdin: { write(data: string) { written.push(data.trim()); push(replies.shift()!); }, flush() {}, end() {} }, stdout, kill() {} };
    return { written, spawn: async () => { queueMicrotask(() => push('{"ready":true,"lang":"en-US"}')); return proc; } };
  }
  test("one process, a line in and a line out: an enlarged pass and a plain pass, in order", async () => {
    const line = (t: string, x: number) => JSON.stringify({ ms: 1, lang: "en-US", scale: 1, lines: [{ text: t, words: [{ t, x, y: 5, w: 30, h: 10 }] }] });
    const io = fake([line("Save", 10), line("Open", 200)]), ocr = createOcr(io.spawn);
    expect(await ocr.ready()).toEqual({ ready: true, lang: "en-US" });
    expect((await ocr(new Uint8Array([1, 2, 3]))).map((l) => l.text)).toEqual(["Save", "Open"]);
    expect(io.written).toEqual(["png 2 AQID", "png 1 AQID"]);
  });
  test("a failed recognition does not wedge the queue", async () => {
    const io = fake(['{"error":"bad image"}', '{"ms":1,"lang":"en-US","lines":[]}']), ocr = createOcr(io.spawn);
    await expect(ocr.recognize(new Uint8Array([1]))).rejects.toThrow("bad image");
    expect((await ocr.recognize(new Uint8Array([1]))).lines).toEqual([]);
  });
});
