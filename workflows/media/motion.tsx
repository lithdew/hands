import React, {useLayoutEffect, useRef, useState} from "react";
import {AbsoluteFill, Audio, Img, staticFile, useCurrentFrame} from "remotion";
import type {PreparedScene} from "./storyboard";
import {assertCaptionHeight, CAPTION_TOP, evidencePhase, headlineSize, taskLabelSize, workflowLabelSize} from "./layout";
import {MathLayout} from "./math-layout";

const INK="#111216", IVORY="#f5f0e6", BLUE="#2545ff";
const FONT="'Segoe UI', Arial, sans-serif";
export const rise=(frame:number,delay=0,duration=22)=>{const t=Math.max(0,Math.min(1,(frame-delay)/duration));return 1-(1-t)**3;};
export function inferredLayout(scene:PreparedScene) {
  if(scene.layout)return scene.layout;
  if(scene.imageAsset)return "artifact-stage";
  if(scene.workflow||/jev.*specialist|specialist.*jev/i.test(scene.title))return "workflow";
  if(scene.visual==="closing")return "closing-mark";
  if(scene.chips||scene.visual==="bullets")return "task-field";
  return scene.visual==="title"?"kinetic-title":"editorial";
}
function Fit({children,width,height,id,min=.84}:{children:React.ReactNode;width:number;height:number;id:string;min?:number}) {
  const ref=useRef<any>(null),[scale,setScale]=useState(1);
  useLayoutEffect(()=>{const s=Math.min(1,height/ref.current.scrollHeight);if(!Number.isFinite(s)||s<min)throw new Error(`${id}: shorten copy for this motion layout; text would become too small`);setScale(s);},[id,height]);
  return <div style={{width,height}}><div ref={ref} style={{width,display:"flow-root",transform:`scale(${scale})`,transformOrigin:"top left"}}>{children}</div></div>;
}
function Words({text,frame,size=72,width=1120,emphasis,accent,color}:{text:string;frame:number;size?:number;width?:number;emphasis?:string;accent:string;color:string}) {
  const words=text.split(/\s+/);
  let cursor=0;const emphasizedAt=emphasis?text.indexOf(emphasis):-1;
  return <div style={{width,fontSize:size,fontWeight:750,letterSpacing:-size*.045,lineHeight:1.02,display:"flex",flexWrap:"wrap",columnGap:size*.23,rowGap:3}}>{words.map((word,i)=>{
    const progress=rise(frame,i*Math.min(3,18/words.length),22);
    const start=text.indexOf(word,cursor);cursor=start+word.length;
    const highlighted=emphasizedAt>=0&&start>=emphasizedAt&&cursor<=emphasizedAt+emphasis!.length;
    return <span key={i} style={{overflow:"hidden",display:"inline-block",paddingBottom:5}}><span style={{display:"block",color:highlighted?accent:color,transform:`translateY(${(1-progress)*110}%)`}}>{word}</span></span>;
  })}</div>;
}
function Caption({scene,color,border}:{scene:PreparedScene;color:string;border:string}) {
  const ref=useRef<any>(null);useLayoutEffect(()=>{if(ref.current)assertCaptionHeight(ref.current.scrollHeight);},[scene.id]);
  return scene.caption?<div style={{position:"absolute",left:58,top:CAPTION_TOP,width:1164,borderTop:`1px solid ${border}`,paddingTop:14,fontSize:21,lineHeight:1.25,color}}><div ref={ref}>{scene.caption}</div></div>:null;
}
function Workflow({scene,frame,color,muted,accent,light}:{scene:PreparedScene;frame:number;color:string;muted:string;accent:string;light:boolean}) {
  const nodes=scene.workflow??[{label:"Jev",detail:"Select the next action"},{label:"Specialist",detail:"Create the expressive work"},{label:"Result",detail:"Return an inspected artifact"}];
  const width=nodes.length===3?300:244, gap=(1164-width*nodes.length)/(nodes.length-1), cycle=Math.max(0,(frame-30)/108),progress=cycle%1;
  return <>
    <div style={{position:"absolute",left:58,top:90}}><Fit width={1164} height={83} id={`${scene.id}-workflow-heading`}><Words text={scene.title} frame={frame} size={headlineSize(scene.title,1164,83,[64,54,44,36])} emphasis={scene.emphasis} color={color} accent={accent}/></Fit></div>
    {scene.body&&<div style={{position:"absolute",left:60,top:182,fontSize:25,color:muted,opacity:rise(frame,12)}}><Fit width={1164} height={32} id={`${scene.id}-workflow-subtitle`}>{scene.body}</Fit></div>}
    <svg width="1164" height="100" style={{position:"absolute",left:58,top:215,overflow:"visible"}}>
      <defs><marker id={`${scene.id}-arrow`} viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill={accent}/></marker></defs>
      <path d={`M${width/2},20 H${1164-width/2}`} fill="none" stroke={light?"#cecec8":"#35363b"} strokeWidth="2"/>
      <path d={`M${width/2},20 H${width/2+(1164-width)*progress}`} fill="none" stroke={accent} strokeWidth="4"/>
      {nodes.map((_,i)=><path key={i} d={`M${width/2+i*(width+gap)},20 V49`} stroke={accent} fill="none" strokeWidth="2" markerEnd={`url(#${scene.id}-arrow)`} opacity={rise(frame,i*8)}/>)}
      {nodes.slice(1).map((_,i)=><path key={`direction-${i}`} d={`M${width+i*(width+gap)},20 h${gap-12}`} fill="none" stroke={accent} strokeWidth="2" markerEnd={`url(#${scene.id}-arrow)`}/>)}
      <circle cx={width/2+(1164-width)*progress} cy={20} r="8" fill={accent}/>
    </svg>
    {nodes.map((node,i)=>{const p=rise(frame,12+i*8),active=Math.round(progress*(nodes.length-1))===i;return <div key={i} style={{position:"absolute",left:58+i*(width+gap),top:274+(1-p)*35,width,opacity:p}}>
      <div style={{height:125,boxSizing:"border-box",padding:"18px 24px",border:`2px solid ${active?accent:light?"#d2d1ca":"#404148"}`,background:active?BLUE:light?"#fffdf8":INK,color:active?IVORY:color,transition:"none"}}><div style={{fontSize:12,letterSpacing:3,opacity:.7,marginBottom:8}}>0{i+1}</div><Fit width={width-48} height={67} id={`${scene.id}-node-${i}`}><div style={{fontSize:workflowLabelSize(node.label,width-48),lineHeight:1.1,fontWeight:650,letterSpacing:-1.3}}>{node.label}</div></Fit></div>
      {node.detail&&<div style={{fontSize:21,lineHeight:1.3,marginTop:13,color:muted}}><Fit width={width} height={55} id={`${scene.id}-detail-${i}`}>{node.detail}</Fit></div>}
    </div>;})}
    {scene.correction&&<div style={{opacity:rise(frame,60)}}>
      <svg width="1164" height="85" style={{position:"absolute",left:58,top:465,overflow:"visible"}}><path d={`M${1164-width/2},0 V68 H${width/2+width+gap} V8`} stroke={accent} strokeWidth="2" fill="none" markerEnd={`url(#${scene.id}-arrow)`}/></svg>
      <div style={{position:"absolute",left:58+width/2+width+gap+28,top:479,width:350,fontSize:20,lineHeight:1.2,color}}><Fit width={350} height={49} id={`${scene.id}-correction`}>{scene.correction}</Fit></div>
    </div>}
  </>;
}
function Tasks({scene,frame,color,muted,accent,light,restrained}:{scene:PreparedScene;frame:number;color:string;muted:string;accent:string;light:boolean;restrained:boolean}) {
  const tasks=scene.chips??scene.bullets??[scene.body??scene.title],spacing=Math.min(104,430/tasks.length),start=110+(6-tasks.length)*10;
  const points=tasks.map((_,i)=>({x:555+(i%3)*48,y:start+i*spacing}));
  const selected=Math.floor(frame/42)%tasks.length;
  return <>
    <div style={{position:"absolute",left:58,top:112}}><Fit width={435} height={275} id={`${scene.id}-tasks-heading`}><Words text={scene.title} frame={frame} width={435} size={headlineSize(scene.title,435,275,[66,53,46,40])} emphasis={scene.emphasis} color={color} accent={accent}/></Fit></div>
    {scene.body&&<div style={{position:"absolute",left:60,top:387,fontSize:36,lineHeight:1.18,color:muted,opacity:rise(frame,14)}}><Fit width={405} height={150} id={`${scene.id}-tasks-subtitle`}>{scene.body}</Fit></div>}
    <svg width="1280" height="555" style={{position:"absolute",inset:0}}><path d={points.map((p,i)=>`${i?"L":"M"}${p.x},${p.y+25}`).join(" ")} fill="none" stroke={light?"#cecec8":"#43454d"} strokeWidth="2"/>{points.map((p,i)=><circle key={i} cx={p.x} cy={p.y+25} r={selected===i?9:5} fill={selected===i?accent:muted} opacity={rise(frame,i*8)}/>)}</svg>
    {tasks.map((task,i)=>{const p=rise(frame,12+i*8),point=points[i]!,w=1195-point.x-30;
      return <div key={i} style={{position:"absolute",left:point.x+30,top:point.y,width:w,opacity:p,transform:`translateX(${(1-p)*(restrained?15:70)}px)`}}>
        <div style={{fontSize:16,letterSpacing:2,color:muted,marginBottom:5}}>0{i+1}</div><Fit width={w} height={tasks.length>4?49:69} id={`${scene.id}-task-${i}`}><div style={{fontSize:taskLabelSize(task,tasks.length,i)??(tasks.length>4?33:52),lineHeight:1.06,fontWeight:selected===i?700:500,letterSpacing:-1.3,color:selected===i?accent:color}}>{task}</div></Fit>
      </div>;
    })}
  </>;
}
function Artifact({scene,frame,color,muted,accent}:{scene:PreparedScene;frame:number;color:string;muted:string;accent:string}) {
  const evidence=scene.evidence??[],details=evidencePhase(frame,scene.frames,Boolean(evidence.length||scene.body||scene.bullets?.length))==="details";
  const camera=.9+.1*Math.min(1,frame/(scene.frames*.61));
  return <>
    <div style={{position:"absolute",left:58,top:64}}><Fit width={1164} height={47} id={`${scene.id}-artifact-heading`}><Words text={scene.title} frame={frame} size={headlineSize(scene.title,1164,47,[40,34,30])} emphasis={scene.emphasis} color={color} accent={accent}/></Fit></div>
    {!details?<>
      <div style={{position:"absolute",left:60,top:113,fontSize:18,color:muted}}>{scene.artifactLabel}</div>
      <div style={{position:"absolute",left:58,top:145,width:1164,height:375,clipPath:`inset(0 ${100*(1-rise(frame,8,30))}% 0 0)`,transform:`translateX(${(1-camera)*-110}px) scale(${camera})`,transformOrigin:"center center",background:"#e7e4dc",boxShadow:"0 20px 45px #00000015"}}><Img src={staticFile(scene.imageAsset!)} style={{width:"100%",height:"100%",objectFit:"contain"}}/></div>
      <div style={{position:"absolute",left:58,top:533,fontSize:16,color:muted}}>Actual Hands output</div>
    </>:<div style={{position:"absolute",left:58,top:160,width:1164,opacity:rise(frame-scene.frames*.62,0,16),transform:`translateY(${(1-rise(frame-scene.frames*.62))*25}px)`}}><Fit width={1164} height={380} id={`${scene.id}-evidence`}>
      {scene.body&&<p style={{fontSize:27,color:muted,margin:"0 0 25px"}}>{scene.body}</p>}
      {scene.bullets?.map((b,i)=><div key={i} style={{fontSize:25,marginBottom:14}}>{b}</div>)}
      <div style={{display:"grid",gridTemplateColumns:`repeat(${Math.max(1,evidence.length)},1fr)`,gap:38}}>{evidence.map((e,i)=><div key={i} style={{borderTop:`4px solid ${accent}`,paddingTop:20}}><div style={{fontSize:18,color:muted,marginBottom:17}}>{e.label}</div><div style={{fontSize:32,lineHeight:1.15,fontWeight:600,letterSpacing:-.8,marginBottom:24}}>{e.value}</div><div style={{fontSize:18,lineHeight:1.3,color:muted,overflowWrap:"anywhere"}}>{e.source}</div></div>)}</div>
      <div style={{marginTop:26,color:muted,fontSize:18}}>{scene.artifactLabel}</div>
    </Fit></div>}
  </>;
}
export function MotionScene({scene,index,total,restrained=false}:{scene:PreparedScene;index:number;total:number;restrained?:boolean}) {
  const frame=useCurrentFrame(),layout=inferredLayout(scene),tone=scene.tone??(layout==="workflow"||layout==="artifact-stage"?"ivory":layout==="closing-mark"?"cobalt":"ink");
  const light=tone==="ivory",bg=light?IVORY:tone==="cobalt"?BLUE:INK,color=light?INK:IVORY,muted=light?"#60615e":"#c1c1c7",accent=tone==="cobalt"?IVORY:tone==="ink"?"#91a3ff":BLUE;
  // One line of display type when it fits, else the next rung: the storyboard's 60-character title cap is
  // legible at every rung, so headlines are never refused at render for wrapping past their lane.
  const titleSize=headlineSize(scene.title,1164,238,[174,91,72,60]), huge=titleSize>=174;
  const textY=layout==="editorial"?104:huge?130:122;
  return <AbsoluteFill style={{background:bg,color,fontFamily:FONT,overflow:"hidden"}}>
    <div style={{position:"absolute",left:58,top:26,fontSize:18,fontWeight:750,letterSpacing:-.5}}>hands<span style={{color:accent}}>.</span></div>
    <div style={{position:"absolute",right:58,top:30,fontSize:12,letterSpacing:2,color:muted}}>{String(index+1).padStart(2,"0")} / {String(total).padStart(2,"0")}</div>
    {scene.kicker&&<div style={{position:"absolute",left:185,top:31,fontSize:12,letterSpacing:2,textTransform:"uppercase",color:muted,opacity:rise(frame)}}>{scene.kicker}</div>}
    {scene.math?<MathLayout {...{scene,color,muted}} accent={tone==="ink"?"#91a3ff":accent}/>:layout==="workflow"?<Workflow {...{scene,frame,color,muted,accent,light}}/>:layout==="task-field"?<Tasks {...{scene,frame,color,muted,accent,light,restrained}}/>:layout==="artifact-stage"&&scene.imageAsset?<Artifact {...{scene,frame,color,muted,accent}}/>:layout==="editorial"?<>
      <div style={{position:"absolute",left:58,top:118}}><Fit width={470} height={355} id={`${scene.id}-editorial-heading`}><Words text={scene.title} frame={frame} width={470} size={headlineSize(scene.title,470,355,[72,58,48,42])} emphasis={scene.emphasis} color={color} accent={accent}/></Fit></div>
      <div style={{position:"absolute",left:570,top:125,width:4,height:350*rise(frame,12,40),background:accent}}/>
      <div style={{position:"absolute",left:626,top:190,opacity:rise(frame,25)}}><Fit width={570} height={310} id={`${scene.id}-editorial-body`}><div style={{fontSize:39,lineHeight:1.2,letterSpacing:-1,color}}>{scene.body}</div>{scene.bullets?.map(b=><div key={b} style={{fontSize:25,marginTop:20,color:muted}}>{b}</div>)}</Fit></div>
    </>:layout==="closing-mark"?<>
      <div style={{position:"absolute",left:58,top:112}}><Fit width={1164} height={230} id={`${scene.id}-closing-title`}><Words text={scene.title} frame={frame} size={headlineSize(scene.title,1164,230,[180,120,80,64])} emphasis={scene.emphasis} color={color} accent={accent}/></Fit></div>
      <div style={{position:"absolute",left:60,top:365,width:100*rise(frame,8,40),height:6,background:accent}}/>
      <div style={{position:"absolute",left:210,top:350,opacity:rise(frame,20)}}><Fit width={985} height={170} id={`${scene.id}-closing-body`}><div style={{fontSize:38,lineHeight:1.2,letterSpacing:-1}}>{scene.body}</div></Fit></div>
    </>:<>
      <div style={{position:"absolute",left:58,top:textY,width:1164}}><Fit width={1164} height={huge?210:238} id={`${scene.id}-headline`}><Words text={scene.title} frame={frame} size={titleSize} emphasis={scene.emphasis} color={color} accent={accent}/></Fit></div>
      <div style={{position:"absolute",left:60,top:huge?364:392,width:1060,opacity:rise(frame,20),transform:`translateY(${(1-rise(frame,20))*24}px)`}}><Fit width={1060} height={144} id={`${scene.id}-copy`}><div style={{fontSize:28,lineHeight:1.28,color:muted}}>{scene.body}</div>{scene.bullets?.map((b,i)=><div key={i} style={{fontSize:23,lineHeight:1.25,marginTop:13,transform:`translateX(${(1-rise(frame,25+i*5))*35}px)`}}>{b}</div>)}</Fit></div>
      <div style={{position:"absolute",left:58,top:huge?345:374,height:5,width:180*rise(frame,15,35),background:accent}}/>
    </>}
    <Caption scene={scene} color={color} border={light?"#cfcec7":tone==="cobalt"?"#738aff":"#36373e"}/>
    <div style={{position:"absolute",left:58,bottom:39,fontSize:11,letterSpacing:3,color:muted}}>HANDS / {scene.visual==="matrix"?"EXPLAIN":"MAKE IT REAL"}</div>
    <div style={{position:"absolute",right:58,bottom:42,width:220,height:2,background:light?"#d0cfc8":"#5b6080"}}><div style={{height:2,width:`${100*(index+frame/scene.frames)/total}%`,background:accent}}/></div>
    {!restrained&&scene.visual!=="closing"&&frame>scene.frames-9&&<div style={{position:"absolute",inset:0,background:accent,transform:`translateX(${100*(1-rise(frame,scene.frames-9,9))}%)`}}/>}
    {scene.audioAsset&&<Audio src={staticFile(scene.audioAsset)}/>}
  </AbsoluteFill>;
}
