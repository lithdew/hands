import React from "react";
import {useCurrentFrame} from "remotion";
import {determinant,type PreparedScene} from "./storyboard";

const n=(x:number)=>Number.isInteger(x)?String(x):Number(x.toFixed(3)).toString();
export function rational(numerator:number,denominator:number):string {
  const gcd=(a:number,b:number):number=>b?gcd(b,a%b):Math.abs(a);
  const divisor=gcd(numerator,denominator),sign=denominator<0?-1:1,a=numerator/divisor*sign,b=Math.abs(denominator/divisor);
  return b===1?String(a):`${a}/${b}`;
}
const reveal=(frame:number,delay:number)=>Math.max(0,Math.min(1,(frame-delay)/24));
function Matrix({values,accent,frame,delay=0}:{values:(string|number)[][];accent:string;frame:number;delay?:number}){
  return <span style={{display:"inline-grid",gridTemplateColumns:`repeat(${values[0]!.length},minmax(54px,auto))`,gap:"22px 35px",padding:"23px 25px",borderLeft:"3px solid",borderRight:"3px solid",borderRadius:8,fontSize:54,lineHeight:1,fontVariantNumeric:"tabular-nums",fontWeight:500}}>
    {values.flatMap((row,i)=>row.map((value,j)=><span key={`${i}-${j}`} style={{textAlign:"center",color:i===j?accent:"inherit",opacity:reveal(frame,delay+12*(i*row.length+j)),transform:`translateY(${14*(1-reveal(frame,delay+12*(i*row.length+j)))}px)`}}>{typeof value==="number"?n(value):value}</span>))}
  </span>;
}
function Fraction({top,bottom}:{top:string;bottom:string}){return <span style={{display:"inline-flex",flexDirection:"column",alignItems:"center",gap:12,fontSize:48,lineHeight:1.15}}><span>{top}</span><span style={{borderTop:"2px solid",paddingTop:12}}>{bottom}</span></span>;}

/** Semantic equation data, not arbitrary TeX/code. Numeric answers are computed
 * from the same matrix contract as Manim rather than copied from prose. */
export function MathLayout({scene,color,muted,accent}:{scene:PreparedScene;color:string;muted:string;accent:string}){
  const frame=useCurrentFrame(),math=scene.math!;
  const matrix=math.matrix;
  const adj=matrix?[[matrix[1][1],-matrix[0][1]],[-matrix[1][0],matrix[0][0]]]:undefined,det=matrix?determinant(matrix):1;
  const exactInverse=adj?.map(row=>row.map(value=>rational(value,det)));
  const vector=math.vector,answer=adj&&vector?adj.map(row=>rational(row[0]!*vector[0]+row[1]!*vector[1],det)):undefined;
  const equationStyle:React.CSSProperties={display:"flex",alignItems:"center",justifyContent:"center",gap:28,fontSize:64,letterSpacing:-2,width:1164,minHeight:230};
  const step=Math.min(2,Math.floor(frame/(scene.frames/3)));
  return <>
    <div style={{position:"absolute",left:58,top:87,fontSize:44,fontWeight:700,letterSpacing:-1.7,lineHeight:1.1,width:1164}}>{scene.title}</div>
    <div style={{position:"absolute",left:58,top:185,color,...equationStyle}}>
      {math.kind==="inverse-formula"?<><span>A⁻¹ =</span><Fraction top="1" bottom="ad − bc"/><Matrix values={[["d","−b"],["−c","a"]]} {...{accent,frame}} delay={30}/></>
      :math.kind==="identity"?<><span style={{color:step===0?accent:color}}>A⁻¹</span><span>A</span><span>=</span><Matrix values={[[1,0],[0,1]]} {...{accent,frame}} delay={24}/><span>= I</span></>
      :math.kind==="inverse-example"&&matrix&&adj?<><Matrix values={matrix} {...{accent,frame}}/><span style={{fontSize:44,color:accent,opacity:reveal(frame,35)}}>→</span><span style={{opacity:reveal(frame,50)}}><Fraction top="1" bottom={n(det)}/></span><Matrix values={adj} {...{accent,frame}} delay={65}/></>
      :math.kind==="solve"&&exactInverse&&vector&&answer?<><span>x =</span><Matrix values={exactInverse} {...{accent,frame}}/><Matrix values={vector.map(x=>[x])} {...{accent,frame}} delay={35}/><span style={{opacity:reveal(frame,65)}}>=</span><Matrix values={answer.map(x=>[x])} {...{accent,frame}} delay={70}/></>:null}
    </div>
    <div style={{position:"absolute",top:441,left:58,width:1164,display:"flex",justifyContent:"center",gap:36,color:muted,fontSize:21,letterSpacing:1}}>
      {(math.kind==="inverse-formula"||math.kind==="inverse-example"?["Swap the diagonal","Negate the off-diagonal","Divide by the determinant"]:math.kind==="identity"?["Transform","Reverse","Return to identity"]:["Inverse","Known output","Recovered input"]).map((label,i)=><span key={label} style={{borderTop:`3px solid ${step===i?accent:"transparent"}`,paddingTop:12,color:step===i?color:muted}}>{label}</span>)}
    </div>
    {scene.body&&<div style={{position:"absolute",left:78,top:502,width:1124,fontSize:23,lineHeight:1.2,textAlign:"center",color:muted}}>{scene.body}</div>}
  </>;
}
