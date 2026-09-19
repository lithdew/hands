import {expect,test} from "bun:test";
import {rational} from "./math-layout";
import {storyboardSchema} from "./storyboard";

test("typeset worked results use exact signed rational values",()=>{
  expect(rational(1,3)).toBe("1/3");expect(rational(4,-6)).toBe("-2/3");
  expect(rational(0,-5)).toBe("0");expect(rational(-10,-5)).toBe("2");
});
test("worked equations reject singular or non-integer inputs and absent solve vector",()=>{
  const scene={id:"example",title:"Solve",durationSeconds:8,visual:"bullets"};
  const base={version:1,title:"Math",kind:"pitch",scenes:[{...scene,id:"title"},scene],sources:[]};
  for(const math of [{kind:"solve",matrix:[[2,1],[1,1]]},{kind:"inverse-example",matrix:[[1,2],[1,2]]},{kind:"inverse-example",matrix:[[.5,0],[0,1]]}])
    expect(storyboardSchema.safeParse({...base,scenes:[{...scene,id:"title"},{...scene,math}]}).success).toBe(false);
  expect(storyboardSchema.safeParse({...base,scenes:[{...scene,id:"title"},{...scene,math:{kind:"solve",matrix:[[2,1],[1,1]],vector:[5,3]}}]}).success).toBe(true);
});
