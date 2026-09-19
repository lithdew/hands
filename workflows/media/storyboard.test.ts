import {describe, expect, test} from "bun:test";
import {determinant, inverse, storyboardSchema} from "./storyboard";
const base={version:1,title:"A lesson",kind:"matrix-inversion",sources:[],scenes:[{id:"opening",title:"Why an inverse?",visual:"title",durationSeconds:4},{id:"example",title:"Undo A",visual:"matrix",durationSeconds:6,matrix:[[2,1],[1,1]]}]};
describe("bounded media storyboard",()=>{
  test("validates dynamically chosen invertible example and computes both identity products",()=>{
    const spec=storyboardSchema.parse(base); const a=spec.scenes[1]!.matrix!;const b=inverse(a)!;
    expect(determinant(a)).toBe(1);expect(b).toEqual([[1,-1],[-1,2]]);
    for(const [left,right] of [[a,b],[b,a]])for(let r=0;r<2;r++)for(let c=0;c<2;c++)expect(left![r]![0]! * right![0]![c]!+left![r]![1]! * right![1]![c]!).toBe(r===c?1:0);
  });
  test("singular matrix has no inverse",()=>{expect(inverse([[1,2],[1,2]])).toBeNull();});
  test("rejects executable fields, unbounded matrices and arbitrary media URLs",()=>{
    expect(()=>storyboardSchema.parse({...base,script:"send secrets"})).toThrow();
    expect(()=>storyboardSchema.parse({...base,scenes:[base.scenes[0],{...base.scenes[1],matrix:[[100,0],[0,1]]}]})).toThrow();
    expect(()=>storyboardSchema.parse({...base,scenes:[base.scenes[0],{...base.scenes[1],artifactImage:"https://example.test/private.png"}]})).toThrow();
  });
  test("cannot claim inversion with only a singular demonstration",()=>{
    expect(()=>storyboardSchema.parse({...base,scenes:[base.scenes[0],{...base.scenes[1],matrix:[[1,2],[1,2]]}]})).toThrow();
  });
  test("rejects copy a phone-sized player could not show and names the scene",()=>{
    const long=(n:number)=>"word ".repeat(Math.ceil(n/5)).trim().slice(0,n);
    expect(()=>storyboardSchema.parse({...base,scenes:[{...base.scenes[0],title:long(80)},base.scenes[1]]})).toThrow();
    expect(()=>storyboardSchema.parse({...base,scenes:[{...base.scenes[0],body:long(160),bullets:[long(88),long(88),long(88),long(88)],durationSeconds:30},base.scenes[1]]})).toThrow(/420/);
    expect(()=>storyboardSchema.parse({...base,scenes:[base.scenes[0],{...base.scenes[1],body:long(121)}]})).toThrow(/animation shares the frame/);
    expect(()=>storyboardSchema.parse({...base,scenes:[base.scenes[0],{...base.scenes[1],bullets:["a","b","c","d"]}]})).toThrow(/at most 3 bullets/);
    expect(()=>storyboardSchema.parse({...base,scenes:[{...base.scenes[0],body:long(150),durationSeconds:3},base.scenes[1]]})).toThrow(/reading time/);
    expect(()=>storyboardSchema.parse({...base,scenes:[{...base.scenes[0],matrixName:"S"},base.scenes[1]]})).toThrow(/matrixName/);
    expect(storyboardSchema.parse({...base,scenes:[base.scenes[0],{...base.scenes[1],matrixName:"S"}]}).scenes[1]!.matrixName).toBe("S");
  });
  test("rejects duplicate ids and overlong videos",()=>{
    expect(()=>storyboardSchema.parse({...base,scenes:[{...base.scenes[0],id:"same"},{...base.scenes[1],id:"same"}]})).toThrow();
    expect(()=>storyboardSchema.parse({...base,kind:"pitch",scenes:Array.from({length:9},(_,i)=>({...base.scenes[0],id:`scene-${i}`,durationSeconds:30}))})).toThrow();
  });
});
