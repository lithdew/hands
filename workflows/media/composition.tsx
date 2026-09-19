import React, {useLayoutEffect, useRef, useState} from "react";
import {AbsoluteFill, Audio, Composition, Img, OffthreadVideo, Sequence, interpolate, registerRoot, staticFile, useCurrentFrame} from "remotion";
import type {PreparedStoryboard, PreparedScene} from "./storyboard";
import {inverse} from "./storyboard";
import {matrixPhaseLabel, matrixTextScale} from "./layout";

const colors = {bg:"#0b1422", muted:"#a9b8cc", text:"#f1f5fa", cyan:"#61ded8", gold:"#ffd174"};
const font = "'Segoe UI', Arial, sans-serif";
const fmt = (n: number) => Number(n.toFixed(3)).toString();
function Matrix({value, label}: {value: number[][]; label: string}) {
  return <div style={{display:"flex",alignItems:"center",gap:13}}><span style={{fontSize:28,color:colors.muted}}>{label}</span><div style={{display:"grid",gridTemplateColumns:"repeat(2, 54px)",textAlign:"center",gap:"8px 5px",borderLeft:`3px solid ${colors.cyan}`,borderRight:`3px solid ${colors.cyan}`,padding:"8px 13px",fontSize:29}}>{value.flat().map((x,i)=><span key={i}>{fmt(x)}</span>)}</div></div>;
}
function MatrixText({children, sceneId}: {children: React.ReactNode; sceneId: string}) {
  const content=useRef<any>(null), [scale,setScale]=useState(1);
  // System fonts are local and layout measurement is synchronous before paint.
  // Scale the copy as one unit; video and bottom captions keep their own lanes.
  useLayoutEffect(()=>{setScale(matrixTextScale(content.current.scrollHeight));},[sceneId]);
  return <div data-matrix-text-panel style={{position:"absolute",top:25,left:0,width:435,height:555}}>
    <div ref={content} data-matrix-text-content style={{display:"flow-root",width:435,transform:`scale(${scale})`,transformOrigin:"top left"}}>{children}</div>
  </div>;
}
function Scene({scene, index, total}: {scene: PreparedScene;index:number;total:number}) {
  const f=useCurrentFrame();
  const reveal=interpolate(f,[0,Math.min(14,scene.frames/5)],[0,1],{extrapolateRight:"clamp"});
  const matrix=scene.matrix;
  const inverseMatrix=matrix ? inverse(matrix) : null;
  const matrixMode=scene.visual==="matrix";
  const caption = scene.caption ?? "";
  const bullets=scene.bullets ?? [];
  const heading=<h1 style={{fontSize:scene.visual==="title"||scene.visual==="closing"?64:46,lineHeight:1.1,fontWeight:650,maxWidth:matrixMode?435:1130,margin:"16px 0 20px",letterSpacing:-1.5}}>{scene.title}</h1>;
  const copy=<div style={{width:matrixMode?415:scene.imageAsset?460:"100%",flexShrink:0}}>
    {scene.body && <p style={{color:colors.muted,fontSize:matrixMode?25:31,lineHeight:1.32,margin:"0 0 25px",maxWidth:1010}}>{scene.body}</p>}
    {bullets.length>0 && <div style={{display:"flex",flexDirection:"column",gap:18}}>{bullets.map((b,i)=><div key={i} style={{display:"flex",gap:15,alignItems:"flex-start",fontSize:matrixMode?23:28,lineHeight:1.23,opacity:interpolate(f,[8+i*6,18+i*6],[0,1],{extrapolateLeft:"clamp",extrapolateRight:"clamp"})}}><span style={{color:colors.cyan,fontSize:17,paddingTop:7}}>●</span><span>{b}</span></div>)}</div>}
    {matrix && <div style={{display:"flex",flexDirection:"column",gap:20,marginTop:24}}><Matrix value={matrix} label="A ="/>{inverseMatrix ? <Matrix value={inverseMatrix} label="A⁻¹ ="/> : <span style={{fontSize:28,color:colors.gold}}>det(A) = 0 · no inverse</span>}</div>}
    {(scene.evidence?.length ?? 0)>0 && <div style={{display:"flex",gap:20,marginTop:22}}>{scene.evidence!.map((item,i)=><div key={i} style={{flex:1,borderTop:`2px solid ${colors.cyan}`,padding:"20px 15px 10px 0"}}><div style={{fontSize:18,color:colors.cyan,marginBottom:12}}>{item.label}</div><div style={{fontSize:27,lineHeight:1.2,marginBottom:16}}>{item.value}</div><div style={{fontSize:13,color:colors.muted,overflowWrap:"anywhere"}}>{item.source}</div></div>)}</div>}
  </div>;
  return <AbsoluteFill style={{background:colors.bg,color:colors.text,fontFamily:font,padding:"44px 58px 88px",overflow:"hidden"}}>
    <div style={{position:"absolute",inset:0,background:"radial-gradient(ellipse at 90% 15%, #18384a 0%, transparent 60%)",opacity:.7}} />
    <div style={{position:"absolute",left:58,top:28,fontSize:15,letterSpacing:4,color:colors.cyan,fontWeight:700}}>HANDS / {matrixMode ? "LINEAR ALGEBRA" : "STUDIO"}</div>
    <div style={{position:"absolute",right:58,top:28,color:colors.muted,fontSize:15}}>{String(index+1).padStart(2,"0")} / {String(total).padStart(2,"0")}</div>
    <div style={{position:"relative",paddingTop:25,opacity:reveal,transform:`translateY(${(1-reveal)*14}px)`,display:"flex",flexDirection:"column",height:"100%"}}>
      {matrixMode?<MatrixText sceneId={scene.id}>{heading}{copy}</MatrixText>:heading}
      <div style={{display:"flex",gap:35,flex:1,minHeight:0}}>
        {!matrixMode&&copy}
        {matrixMode && scene.videoAsset && <div style={{position:"absolute",right:-28,top:106,width:745,height:460,borderRadius:18,overflow:"hidden"}}><OffthreadVideo src={staticFile(scene.videoAsset)} muted style={{width:"100%",height:"100%",objectFit:"contain"}}/><div style={{position:"absolute",top:4,right:35,fontSize:17,color:colors.cyan}}>{matrixPhaseLabel(f,scene.frames,Boolean(inverseMatrix))}</div></div>}
        {scene.imageAsset && <div style={{flex:1,minWidth:0,display:"flex",flexDirection:"column",gap:12}}><Img src={staticFile(scene.imageAsset)} style={{width:"100%",height:350,objectFit:"contain",background:"#ffffff",borderRadius:9,border:"1px solid #284254"}}/>{scene.artifactLabel&&<div style={{fontSize:18,color:colors.cyan}}>{scene.artifactLabel}</div>}</div>}
      </div>
    </div>
    {caption && <div style={{position:"absolute",left:58,right:58,bottom:36,fontSize:21,lineHeight:1.25,color:colors.text,borderTop:"1px solid #2c4058",paddingTop:15}}>{caption}</div>}
    <div style={{position:"absolute",left:0,bottom:0,height:5,width:`${100*(index+f/scene.frames)/total}%`,background:colors.cyan}}/>
    {scene.audioAsset && <Audio src={staticFile(scene.audioAsset)}/>}
  </AbsoluteFill>;
}
function Video({storyboard}: {storyboard: PreparedStoryboard}) {return <AbsoluteFill>{storyboard.scenes.map((scene,index)=><Sequence key={scene.id} from={scene.startFrame} durationInFrames={scene.frames}><Scene scene={scene} index={index} total={storyboard.scenes.length}/></Sequence>)}</AbsoluteFill>;}
const blank: PreparedStoryboard={version:1,title:"Hands Studio",kind:"pitch",width:1280,height:720,fps:24,sources:[],scenes:[],durationInFrames:24};
function Root() {return <Composition id="HandsStoryboard" component={Video} width={1280} height={720} fps={24} durationInFrames={24} defaultProps={{storyboard:blank}} calculateMetadata={({props})=>({durationInFrames:props.storyboard.durationInFrames,width:props.storyboard.width,height:props.storyboard.height,fps:props.storyboard.fps})}/>;}
registerRoot(Root);
