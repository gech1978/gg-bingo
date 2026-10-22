(() => {
  const tg=window.Telegram?.WebApp; tg?.ready(); tg?.expand();
  const $=id=>document.getElementById(id);
  let socket, card=null, called=[], roomId="lobby", roomStatus="waiting";
  function toast(msg){const el=$("toast");el.textContent=msg;el.classList.add("show");setTimeout(()=>el.classList.remove("show"),2600)}
  function letter(n){return n<=15?"B":n<=30?"I":n<=45?"N":n<=60?"G":"O"}
  function renderCard(){const root=$("card");root.innerHTML="";if(!card){root.innerHTML='<div class="empty-card">Join a room to get your card</div>';return}const set=new Set(called);card.forEach(row=>row.forEach(n=>{const el=document.createElement("div");el.className="cell"+(n===0?" free marked":set.has(n)?" marked":"");el.textContent=n===0?"★":n;root.appendChild(el)}))}
  function renderCalled(){$("calledCount").textContent=called.length;$("lastCall").textContent=called.length?letter(called[called.length-1])+" "+called[called.length-1]:"—";const root=$("calledNumbers");root.innerHTML="";if(!called.length){root.innerHTML='<span class="muted">Numbers appear here when the round starts.</span>';return}[...called].reverse().forEach((n,i)=>{const el=document.createElement("span");el.className="called-ball"+(!i?" latest":"");el.textContent=letter(n)+" "+n;root.appendChild(el)})}
  function renderWinners(winners=[]){const root=$("winners");root.innerHTML="";if(!winners.length){root.innerHTML='<span class="muted">No winners yet.</span>';return}winners.forEach(w=>{const el=document.createElement("span");el.className="player-chip";el.textContent=`🏆 ${w.name} · ${Number(w.simulatedShare).toFixed(2)} demo points`;root.appendChild(el)})}
  function join(){const id=String($("roomInput").value||"lobby").replace(/[^a-zA-Z0-9_-]/g,"").slice(0,24)||"lobby";socket.emit("room:join",{roomId:id})}
  socket=io({auth:{initData:tg?.initData||"",devId:tg?.initDataUnsafe?.user?.id?String(tg.initDataUnsafe.user.id):"demo-browser",devName:tg?.initDataUnsafe?.user?.first_name||"Demo Player"}});
  socket.on("connect",join);socket.on("connect_error",e=>toast(e.message||"Connection error"));
  socket.on("room:joined",id=>{roomId=id;$("roomLabel").textContent=id;toast("Joined "+id)});
  socket.on("card:deal",c=>{card=c;renderCard()});
  socket.on("room:update",r=>{called=r.called||[];roomStatus=r.status;$("playerCount").textContent=r.players.length;$("gameStatus").textContent=r.status==="playing"?"Round in progress":r.status==="finished"?"Round finished":"Waiting for players";$("players").innerHTML="";r.players.forEach(p=>{const el=document.createElement("span");el.className="player-chip";el.textContent="● "+p.name;$("players").appendChild(el)});$("startBtn").disabled=r.status!=="waiting";$("claimBtn").disabled=r.status!=="playing";$("finishBtn").disabled=r.status!=="playing"||!(r.winners||[]).length;renderCard();renderCalled();renderWinners(r.winners||[])});
  socket.on("number:called",n=>toast("Called: "+letter(n)+" "+n));
  socket.on("bingo:accepted",msg=>toast(msg));socket.on("bingo:rejected",msg=>toast(msg));socket.on("app:error",msg=>toast(msg));
  socket.on("game:finished",d=>{toast(d.message||"Round finished");renderWinners(d.winners||[])});
  $("joinBtn").addEventListener("click",join);$("startBtn").addEventListener("click",()=>socket.emit("game:start"));$("claimBtn").addEventListener("click",()=>socket.emit("bingo:claim"));$("finishBtn").addEventListener("click",()=>socket.emit("round:finish"));
  if(!tg?.initData)toast("Demo preview: open from Telegram for verified identity.");
})();