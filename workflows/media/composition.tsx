import React, {useLayoutEffect, useRef, useState} from "react";
import {AbsoluteFill, Audio, Composition, Img, OffthreadVideo, Sequence, interpolate, registerRoot, staticFile, useCurrentFrame} from "remotion";
import type {PreparedStoryboard, PreparedScene} from "./storyboard";
import {inverse} from "./storyboard";
import {bodyRepeatsMatrixPanel, fitScale, inlineMatrices, matrixLetter, matrixPhaseLabel} from "./layout";

// Every frame is also watched inside a ~360px-wide phone player, so copy is
// set large, kept to one lane and refused (not shrunk) when it would not fit.
const colors = {bg:"#0b1422", body:"#dbe5f1", muted:"#a9b8cc", text:"#f7f9fc", cyan:"#61ded8", gold:"#ffd174", line:"#2c4058"};
const font = "'Segoe UI', Arial, sans-serif";
const PAD=58, CONTENT_W=1280-2*PAD, PANEL_TOP=74, PANEL_H=505, COPY_W=500, VIDEO_W=CONTENT_W-COPY_W-28, VIDEO_H=380;
const fmt = (n: number) => Number(n.toFixed(3)).toString().replace("-", "−");

function InlineMatrix({rows}: {rows: string[][]}) {
  return <span style={{display:"inline-grid",gridTemplateColumns:"auto auto",columnGap:"0.55em",rowGap:"0.04em",padding:"0.08em 0.4em",margin:"0 0.12em",borderLeft:`0.09em solid ${colors.cyan}`,borderRight:`0.09em solid ${colors.cyan}`,borderRadius:"0.18em",verticalAlign:"middle",lineHeight:1.12,textAlign:"center",whiteSpace:"nowrap"}}>{rows.flat().map((cell,i)=><span key={i}>{cell}</span>)}</span>;
}
/** Typeset [[a,b],[c,d]] notation as a real two-row matrix. */
function Rich({text}: {text: string}) {
  return <>{inlineMatrices(text).map((part,i)=>typeof part==="string"?<React.Fragment key={i}>{part}</React.Fragment>:<InlineMatrix key={i} rows={part.rows}/>)}</>;
}
function Matrix({value, label}: {value: number[][]; label: string}) {
  return <div style={{display:"flex",alignItems:"center",gap:14}}><span style={{fontSize:32,color:colors.body,whiteSpace:"nowrap"}}>{label}</span><div style={{display:"grid",gridTemplateColumns:"repeat(2, 66px)",textAlign:"center",gap:"6px 6px",borderLeft:`4px solid ${colors.cyan}`,borderRight:`4px solid ${colors.cyan}`,borderRadius:5,padding:"8px 12px",fontSize:38,fontWeight:600,lineHeight:1.15}}>{value.flat().map((x,i)=><span key={i}>{fmt(x)}</span>)}</div></div>;
}
/** Measure the copy once per scene (system fonts are local, layout is
 * synchronous before paint) and fit it to its lane as one unit. */
function Fit({children, width, height, identity, what, center}: {children: React.ReactNode; width: number; height: number; identity: string; what: string; center?: boolean}) {
  const content=useRef<any>(null), [scale,setScale]=useState(1);
  useLayoutEffect(()=>{ if(content.current) setScale(fitScale(content.current.scrollHeight,height,.8,what)); },[identity,height,what]);
  return <div data-fit-lane style={{width,height,display:"flex",flexDirection:"column",justifyContent:center?"center":"flex-start"}}>
    <div ref={content} data-fit-content style={{display:"flow-root",width,transform:`scale(${scale})`,transformOrigin:center?"left center":"top left"}}>{children}</div>
  </div>;
}
function Scene({scene, index, total}: {scene: PreparedScene;index:number;total:number}) {
  const f=useCurrentFrame();
  const reveal=interpolate(f,[0,Math.min(14,scene.frames/5)],[0,1],{extrapolateRight:"clamp"});
  const matrix=scene.matrix;
  const inverseMatrix=matrix ? inverse(matrix) : null;
  const matrixMode=scene.visual==="matrix";
  const big=scene.visual==="title"||scene.visual==="closing";
  const caption = scene.caption ?? "";
  const bullets=scene.bullets ?? [];
  const letter=matrixLetter([scene.body,scene.title,...bullets,scene.caption],scene.matrixName);
  const headingSize=big?72:matrixMode?48:54, bodySize=matrixMode?30:big?38:34, bulletSize=matrixMode?28:36;
  const heading=<h1 style={{fontSize:headingSize,lineHeight:1.1,fontWeight:700,margin:"0 0 18px",letterSpacing:-1.5,color:colors.text}}><Rich text={scene.title}/></h1>;
  const copy=<div style={{display:"flex",flexDirection:"column",gap:matrixMode?16:24,width:"100%"}}>
    {scene.body && !(matrixMode && bodyRepeatsMatrixPanel(scene.body)) && <p style={{color:colors.body,fontSize:bodySize,lineHeight:1.34,margin:0}}><Rich text={scene.body}/></p>}
    {bullets.length>0 && <div style={{display:"flex",flexDirection:"column",gap:matrixMode?12:18}}>{bullets.map((b,i)=><div key={i} style={{display:"flex",gap:16,alignItems:"flex-start",fontSize:bulletSize,lineHeight:1.3,opacity:interpolate(f,[8+i*6,18+i*6],[0,1],{extrapolateLeft:"clamp",extrapolateRight:"clamp"})}}><span style={{color:colors.cyan,fontSize:bulletSize*.55,paddingTop:bulletSize*.42,flexShrink:0}}>●</span><span><Rich text={b}/></span></div>)}</div>}
    {matrix && <div style={{display:"flex",flexWrap:"wrap",gap:"14px 34px",alignItems:"center",marginTop:6}}><Matrix value={matrix} label={`${letter} =`}/>{inverseMatrix ? <Matrix value={inverseMatrix} label={`${letter}⁻¹ =`}/> : <span style={{fontSize:30,color:colors.gold,fontWeight:600}}>det({letter}) = 0 · no inverse</span>}</div>}
    {(scene.evidence?.length ?? 0)>0 && <div style={{display:"grid",gridTemplateColumns:`repeat(${scene.evidence!.length}, minmax(0, 1fr))`,gap:34,marginTop:8}}>{scene.evidence!.map((item,i)=><div key={i} style={{borderTop:`3px solid ${colors.cyan}`,padding:"18px 0 0"}}><div style={{fontSize:22,color:colors.cyan,marginBottom:12,letterSpacing:1}}>{item.label}</div><div style={{fontSize:36,lineHeight:1.2,marginBottom:14,fontWeight:600}}>{item.value}</div><div style={{fontSize:20,lineHeight:1.3,color:colors.muted,overflowWrap:"anywhere"}}>{item.source}</div></div>)}</div>}
  </div>;
  const phaseLabel=matrixPhaseLabel(f,scene.frames,Boolean(inverseMatrix)).replace(/\bA\b/g,letter);
  return <AbsoluteFill style={{background:colors.bg,color:colors.text,fontFamily:font,overflow:"hidden"}}>
    <div style={{position:"absolute",inset:0,background:"radial-gradient(ellipse at 90% 15%, #18384a 0%, transparent 60%)",opacity:.7}} />
    <div style={{position:"absolute",left:PAD,top:26,fontSize:17,letterSpacing:4,color:colors.cyan,fontWeight:700}}>HANDS / {matrixMode ? "LINEAR ALGEBRA" : "STUDIO"}</div>
    <div style={{position:"absolute",right:PAD,top:26,color:colors.muted,fontSize:17}}>{String(index+1).padStart(2,"0")} / {String(total).padStart(2,"0")}</div>
    <div style={{position:"absolute",left:PAD,top:PANEL_TOP,width:CONTENT_W,height:PANEL_H,opacity:reveal,transform:`translateY(${(1-reveal)*14}px)`}}>
      <Fit width={CONTENT_W} height={PANEL_H} identity={scene.id} what={`Scene "${scene.id}" text`} center>
        {heading}
        {matrixMode ? <div style={{display:"flex",gap:28,alignItems:"flex-start"}}>
          <div style={{width:COPY_W,flexShrink:0}}>{copy}</div>
          {scene.videoAsset && <div style={{position:"relative",width:VIDEO_W,height:VIDEO_H,borderRadius:16,overflow:"hidden",border:"1px solid #24405a",background:colors.bg}}>
            <OffthreadVideo src={staticFile(scene.videoAsset)} muted style={{width:"100%",height:"100%",objectFit:"contain"}}/>
            <div style={{position:"absolute",bottom:12,right:14,fontSize:24,lineHeight:1.2,color:colors.cyan,background:"rgba(11,20,34,.82)",padding:"6px 14px",borderRadius:9,fontWeight:600}}>{phaseLabel}</div>
          </div>}
        </div>
        : scene.imageAsset ? <div style={{display:"flex",gap:32,alignItems:"flex-start"}}>
          <div style={{width:470,flexShrink:0}}>{copy}</div>
          <div style={{flex:1,minWidth:0,display:"flex",flexDirection:"column",gap:12}}><Img src={staticFile(scene.imageAsset)} style={{width:"100%",height:360,objectFit:"contain",background:"#ffffff",borderRadius:12,border:"1px solid #284254"}}/>{scene.artifactLabel&&<div style={{fontSize:22,color:colors.cyan}}>{scene.artifactLabel}</div>}</div>
        </div>
        : copy}
      </Fit>
    </div>
    {caption && <div style={{position:"absolute",left:PAD,right:PAD,bottom:34,fontSize:28,lineHeight:1.3,color:colors.text,borderTop:`1px solid ${colors.line}`,paddingTop:14}}>{caption}</div>}
    <div style={{position:"absolute",left:0,bottom:0,height:6,width:`${100*(index+f/scene.frames)/total}%`,background:colors.cyan}}/>
    {scene.audioAsset && <Audio src={staticFile(scene.audioAsset)}/>}
  </AbsoluteFill>;
}
function Video({storyboard}: {storyboard: PreparedStoryboard}) {return <AbsoluteFill>{storyboard.scenes.map((scene,index)=><Sequence key={scene.id} from={scene.startFrame} durationInFrames={scene.frames}><Scene scene={scene} index={index} total={storyboard.scenes.length}/></Sequence>)}</AbsoluteFill>;}
const blank: PreparedStoryboard={version:1,title:"Hands Studio",kind:"pitch",width:1280,height:720,fps:24,sources:[],scenes:[],durationInFrames:24};
function Root() {return <Composition id="HandsStoryboard" component={Video} width={1280} height={720} fps={24} durationInFrames={24} defaultProps={{storyboard:blank}} calculateMetadata={({props})=>({durationInFrames:props.storyboard.durationInFrames,width:props.storyboard.width,height:props.storyboard.height,fps:props.storyboard.fps})}/>;}
registerRoot(Root);
