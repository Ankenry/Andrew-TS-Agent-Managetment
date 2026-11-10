import {useEffect,useRef,useState,type CSSProperties,type ReactNode} from 'react';

// One native pointer gesture resizes the existing panes without remounting chat.
export default function ResizablePanes({children}:{children:[ReactNode,ReactNode]}){
 const main=useRef<HTMLElement>(null),drag=useRef(false);
 const [share,setShare]=useState(50),[width,setWidth]=useState(0),[resizing,setResizing]=useState(false);
 useEffect(()=>{const node=main.current;if(!node)return;const observer=new ResizeObserver(entries=>setWidth(entries[0].contentRect.width));observer.observe(node);return()=>observer.disconnect();},[]);
 const available=Math.max(0,width-9);
 const minimum=available>=600?Math.max(25,280/available*100):50;
 const maximum=available>=600?Math.min(75,100-320/available*100):50;
 const value=Math.min(maximum,Math.max(minimum,share));
 function update(next:number){const bounded=Math.min(maximum,Math.max(minimum,next));setShare(bounded);}
 function move(clientX:number){const box=main.current?.getBoundingClientRect();if(box)update((clientX-box.left-4.5)/Math.max(1,box.width-9)*100);}
 const style={'--wm-task-share':value+'fr','--wm-chat-share':(100-value)+'fr'} as CSSProperties;
 return <main ref={main} className={'wm-main'+(resizing?' wm-is-resizing':'')} style={style}>
  {children[0]}
  <div className="wm-pane-divider" role="separator" aria-label="Đổi độ rộng checklist và chat" aria-orientation="vertical" aria-controls="wm-panel-tasks wm-panel-chat" aria-valuemin={Math.round(minimum)} aria-valuemax={Math.round(maximum)} aria-valuenow={Math.round(value)} aria-valuetext={'Checklist '+Math.round(value)+'%, chat '+Math.round(100-value)+'%'} aria-disabled={minimum===maximum} tabIndex={minimum===maximum?-1:0} title="Kéo để đổi độ rộng. Phím ← → để điều chỉnh; Enter để chia đều."
   onPointerDown={e=>{if(e.button!==0||minimum===maximum)return;e.preventDefault();e.currentTarget.focus();e.currentTarget.setPointerCapture(e.pointerId);drag.current=true;setResizing(true);}}
   onPointerMove={e=>{if(drag.current)move(e.clientX);}}
   onPointerUp={e=>{if(!drag.current)return;move(e.clientX);drag.current=false;setResizing(false);if(e.currentTarget.hasPointerCapture(e.pointerId))e.currentTarget.releasePointerCapture(e.pointerId);}}
   onLostPointerCapture={()=>{drag.current=false;setResizing(false);}}
   onDoubleClick={()=>update(50)}
   onKeyDown={e=>{let next=value;if(e.key==='ArrowLeft')next-=e.shiftKey?10:1;else if(e.key==='ArrowRight')next+=e.shiftKey?10:1;else if(e.key==='Home')next=minimum;else if(e.key==='End')next=maximum;else if(e.key==='Enter')next=50;else return;e.preventDefault();update(next);}}
  ><span aria-hidden="true"/></div>
  {children[1]}
 </main>;
}
