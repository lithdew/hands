import {expect, test} from "bun:test";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {runOwned} from "./process";

const here=path.dirname(fileURLToPath(import.meta.url)),repo=path.resolve(here,"../..");
const python=path.join(repo,"out/media-python",process.platform==="win32"?"Scripts/python.exe":"bin/python");
const alive=(pid:number)=>{try{process.kill(pid,0);return true;}catch{return false;}};

test("subprocess capture is bounded and rejects a pre-aborted request without spawning",async()=>{
  const result=await runOwned([process.execPath,"-e","console.log('x'.repeat(200000))"],repo);
  expect(result.stdout.length).toBe(65536);
  await expect(runOwned(["this-command-must-not-launch"],repo,{signal:AbortSignal.abort(new Error("corrected"))})).rejects.toThrow("corrected");
});

test("a subprocess deadline terminates the owned process and reports timeout",async()=>{
  const start=performance.now();
  await expect(runOwned([process.execPath,"-e","setInterval(()=>{},1000)"],repo,{timeoutMs:100})).rejects.toThrow("timed out");
  expect(performance.now()-start).toBeLessThan(3000);
});

test.skipIf(!Bun.file(python).size)("owned supervisor returns successful output",async()=>{
  const result=await runOwned([python,path.join(here,"owned_process.py"),process.execPath,"-e","console.log('owned worker completed')"],repo,{supervisor:true,timeoutMs:10000});
  expect(result.stdout).toContain("owned worker completed");
});

test.skipIf(!Bun.file(python).size)("aborting the supervisor kills its descendants but leaves an unrelated owned fixture alive",async()=>{
  const unrelated=Bun.spawn([process.execPath,"-e","setInterval(()=>{},1000)"],{stdout:"ignore",stderr:"ignore",windowsHide:true});
  const abort=new AbortController();let pids:{worker:number;descendant:number}|undefined,pending="";
  const code="const child=Bun.spawn([process.execPath,'-e','setInterval(()=>{},1000)'],{stdout:'ignore',stderr:'ignore',windowsHide:true});console.log(JSON.stringify({worker:process.pid,descendant:child.pid}));setInterval(()=>{},1000);";
  try {
    await expect(runOwned([python,path.join(here,"owned_process.py"),process.execPath,"-e",code],repo,{supervisor:true,signal:abort.signal,timeoutMs:10000,abortGraceMs:50,
      onStdout:text=>{pending+=text;if(pending.includes("\n")){pids=JSON.parse(pending.trim());abort.abort(new Error("test cancellation"));}}})).rejects.toThrow("test cancellation");
    expect(pids).toBeDefined();
    for(let n=0;n<30&&(alive(pids!.worker)||alive(pids!.descendant));n++)await Bun.sleep(20);
    expect(alive(pids!.worker)).toBe(false);expect(alive(pids!.descendant)).toBe(false);
    expect(alive(unrelated.pid)).toBe(true);
  } finally {unrelated.kill();await unrelated.exited;}
},15000);
