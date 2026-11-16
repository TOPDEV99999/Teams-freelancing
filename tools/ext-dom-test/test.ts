/**
 * Runs the Workana extension's page logic (bid.ts, inbox.ts, page.ts) against mock pages in a real Chrome.
 *   node tools/ext-dom-test/run.mjs
 * Results are written into <pre id="out"> as JSON (read back with --dump-dom).
 */
import { bidFormUrl, errorPageTitle, findBidButton, findForm, noConnects } from "../../ext-workana/src/bid";
import { readThread, sendReply } from "../../ext-workana/src/inbox";
import { bidFormUrlFor } from "../../ext-workana/src/config";
import { readBell, readCounters, readThreadList } from "../../ext-workana/src/watch";

type R = { name: string; ok: boolean; detail?: string };
const results: R[] = [];
const check = (name: string, ok: boolean, detail = "") => results.push({ name, ok, detail });
const set = (html: string) => { document.body.innerHTML = html; };

const CHAT = `
  <div id="chatpreview" style="position:fixed;right:10px;bottom:0;width:320px;height:300px;background:#fff">
    <a href="/messages/bid/some-other-job" style="display:none">Place a bid</a>
    <a href="/inbox/some-other-job">Conversation</a>
    <form><textarea name="content" style="width:300px;height:200px"></textarea><button type="submit">Send</button></form>
  </div>`;

async function main() {
  // 1. Job page + chat preview: the preview's text box is not the proposal form, and its hidden link is not our button.
  set(`<header style="position:sticky;top:0">top bar</header>
    <main><h1>Especialista em Estratégias</h1>
      <div class="sidebar"><a class="btn btn-primary" href="/messages/bid/job-x?ref=project_view">Place a bid</a></div>
    </main>${CHAT}`);
  check("chat preview text box is not taken for the proposal form", findForm() === null);
  const b1 = findBidButton({ job_id: "job-x" });
  check("bid button found despite the chat preview", !!b1 && (b1.getAttribute("href") ?? "").includes("job-x"), b1?.outerHTML.slice(0, 80));

  // 2. The real button is hidden (covered / collapsed): fall back to its link.
  set(`<main><a href="/messages/bid/job-y" style="display:none">Place a bid</a></main>${CHAT}`);
  check("no visible button -> none picked from the preview", findBidButton({ job_id: "job-y" }) === null);
  check("direct bid-form link recovered", (bidFormUrl({ job_id: "job-y" }) ?? "").includes("/messages/bid/job-y"));

  // 3. Button found by its label only (no link).
  set(`<main><button class="x1">Enviar propuesta</button></main>${CHAT}`);
  check("bid button found by its label", findBidButton({ job_id: "job-z" })?.textContent === "Enviar propuesta");

  // 3b. Labels from the real pages (Nov 2026) and the direct proposal-form address.
  set(`<main><a class="btn" href="#x">Envía una propuesta</a></main>`);
  check("label 'Envía una propuesta'", findBidButton({ job_id: "q" })?.textContent === "Envía una propuesta");
  set(`<main><div class="tabs"><button>Realizar propuesta</button><button>Consulta</button></div></main>`);
  check("label 'Realizar propuesta'", findBidButton({ job_id: "q" })?.textContent === "Realizar propuesta");
  check("direct form URL from slug", bidFormUrlFor("sales-assistant-x", "") === "https://www.workana.com/messages/bid/sales-assistant-x");
  check("direct form URL from job URL", bidFormUrlFor("??", "https://www.workana.com/job/abc-def?ref=1") === "https://www.workana.com/messages/bid/abc-def");

  // 4. Proposal form page with the chat preview (bigger text box) open.
  set(`<main><form id="BidForm"><textarea id="BidContent" name="content" style="width:400px;height:120px"></textarea>
      <input id="Amount" name="amount"><input id="BidDeliveryTime" name="delivery"><button type="submit">Send</button></form></main>${CHAT}`);
  const f = findForm();
  check("proposal form found (not the chat box)", f?.text.id === "BidContent" && f?.amount?.id === "Amount", `${f?.text.id} ${f?.amount?.id}`);

  // 5. Conversation page with class hints.
  set(`<main><h2>Logo para clínica</h2>
    <div class="messages">
      <div class="message message-own"><span class="author">Yo</span><p>Mi propuesta para su logo</p><time>10:00</time></div>
      <div class="message"><span class="author">Ana P.</span><p>Hola, tengo una duda sobre los plazos.</p><p>¿Pueden ser 5 días?</p><time>10:05</time></div>
      <div class="message message-own"><span class="author">Yo</span><p>Claro que sí</p><time>10:07</time></div>
    </div>
    <form id="reply"><textarea name="message" style="width:500px;height:80px"></textarea><button type="submit" class="btn">Enviar</button></form>
  </main>${CHAT}`);
  const t = readThread("logo");
  check("thread: 3 messages read", t.messages.length === 3, JSON.stringify(t.messages));
  check("thread: mine/theirs", t.messages.map((m) => m.mine).join() === "true,false,true", t.messages.map((m) => m.mine).join());
  check("thread: client's multi-line text", t.messages[1]?.text === "Hola, tengo una duda sobre los plazos.\n¿Pueden ser 5 días?", t.messages[1]?.text);
  check("thread: author + time", t.messages[1]?.author === "Ana P." && t.messages[1]?.time === "10:05", `${t.messages[1]?.author}|${t.messages[1]?.time}`);
  check("thread: client name", t.name === "Ana P.", t.name);
  check("thread: reply box is not the chat preview's", t.can_reply);

  // 6. Conversation without helpful classes: right-aligned bubbles are mine.
  set(`<main><div id="list" style="width:600px">
      <div class="r1"><div style="width:300px;background:#eee">Hola, ¿sigue disponible?</div><small>09:00</small></div>
      <div class="r1"><div style="width:300px;margin-left:300px;background:#ddf">Sí, claro</div><small>09:01</small></div>
      <div class="r1"><div style="width:300px;background:#eee">Perfecto, gracias</div><small>09:02</small></div>
    </div><textarea style="width:500px;height:60px"></textarea><button>➤</button></main>`);
  const t2 = readThread("x");
  check("plain thread: 3 messages", t2.messages.length === 3, JSON.stringify(t2.messages));
  check("plain thread: alignment -> mine", t2.messages.map((m) => m.mine).join() === "false,true,false", t2.messages.map((m) => m.mine).join());
  check("plain thread: time stripped from text", t2.messages[0]?.text === "Hola, ¿sigue disponible?", t2.messages[0]?.text);

  // 7. Sending a reply: typed into the conversation's box, send clicked, verified on the page.
  set(`<main><div class="messages"><div class="message"><p>¿Cuándo empieza?</p></div><div class="message"><p>Mañana</p></div></div>
    <form id="reply" onsubmit="return false"><textarea name="message" style="width:500px;height:80px"></textarea><button type="submit">Enviar</button></form></main>${CHAT}`);
  const form = document.getElementById("reply") as HTMLFormElement;
  let clicked = 0;
  form.querySelector("button")!.addEventListener("click", (e) => {
    e.preventDefault();
    clicked++;
    const ta = form.querySelector("textarea")!;
    const div = document.createElement("div");
    div.className = "message message-own";
    div.innerHTML = `<p></p>`;
    div.querySelector("p")!.textContent = ta.value;
    document.querySelector(".messages")!.appendChild(div);
    setTimeout(() => { ta.value = ""; }, 200);
  });
  const chatBox = document.querySelector<HTMLTextAreaElement>("#chatpreview textarea")!;
  const sent = await sendReply("Podemos empezar el lunes, ¿le parece bien?");
  check("reply sent + verified", sent.ok && !!sent.verified && clicked === 1, JSON.stringify(sent));
  check("chat preview box untouched", chatBox.value === "");

  // 8. Closed conversation (no reply box) -> clear error, nothing clicked.
  set(`<main><div class="messages"><div class="message"><p>a</p></div><div class="message"><p>b</p></div></div></main>`);
  const closed = await sendReply("hola");
  check("no reply box -> error", !closed.ok && /no reply box/.test(closed.error ?? ""), JSON.stringify(closed));

  // 9. Workana's REAL conversation page (markup from the page captures, Nov 2026).
  const HEADER = `<header><ul class="nav navbar-nav navbar-right navbar-user">
    <li class="dropdown dropdown-notifications"><a class="dropdown-toggle" href="#notifications"><span class="wk2-icon wk2-icon-bell-b notification-icon"></span></a>
      <div class="dropdown-container" style="display:none"><ul class="dropdown-menu notifications">
        <li class="notification"><div><h6 class="notification-title">Tu propuesta no fue aceptada <span>Ayer</span></h6><p>En Experto en Hotmart para Configuración Completa de Landing</p></div></li>
        <li class="notification"><div><h6 class="notification-title">Tu propuesta no fue aceptada <span>Hace 2 días</span></h6><p>En Carga de Catálogo de Productos en Excel para Uber Eats</p></div></li>
      </ul></div></li>
    <li class="dropdown dropdown-notifications"><a class="dropdown-toggle" href="#threads"><span class="wk2-icon wk2-icon-messages-b notification-icon no-messages"></span></a>
      <div class="dropdown-container" style="display:none"><ul class="dropdown-menu threads list-notifications">
        <li class="notification notification"><a class="notification-link" href="https://www.workana.com/messages/index/roteirista-horror/sample-freelancer"><div class="profile-photo"><img title="Paula M."></div><h6 class="notification-title">Roteirista para Série de Animação de Horror Cósmico</h6><p>O maior desafio de uma série de horror cósmico não...</p></a></li>
        <li class="notification notification"><a class="notification-link" href="https://www.workana.com/messages/index/disenador-vestuario/sample-freelancer"><div class="profile-photo"><img title="Marta"></div><h6 class="notification-title">Diseñador de Vestuario para Producciones Audiovisuales</h6><p>Hola Marta, me interesa saber el estilo...</p></a></li>
      </ul></div></li></ul></header>`;
  set(`${HEADER}<section class="messages-new"><div class="messages-new-wrapper">
    <div class="messages-new-roaster"><section class="with-search"><nav><ul class="list-unstyled">
      <li class="user active"><a href="#open"><div class="user-wrapper"><img title="Paula M."></div><h4 class="ellipsis"><span>Paula M.</span></h4><p class="ellipsis"><span>Roteirista para Série de Animação de Horror Cósmico</span></p></a></li>
      <li class="user"><a href="#open"><h4 class="ellipsis"><span>Nora K.</span></h4><p class="ellipsis"><span>Traductor Literario Profesional Español-Inglés</span></p></a></li>
      <li class="user"><a href="#open"><h4 class="ellipsis"><span>Leo S.</span></h4><p class="ellipsis"><span>Backend Senior / Data Engineer</span></p></a></li>
      <li class="user"><a href="#open"><h4 class="ellipsis"><span>Iris</span></h4><p class="ellipsis"><span>Copia e Fortificação de Site Wordpress</span></p></a></li>
    </ul></nav></section></div>
    <div class="messages-new-content"><div class="messages-new-title"><div class="bid-title h4"><a class="ellipsis" href="https://www.workana.com/job/roteirista-horror">Roteirista para Série de Animação de Horror Cósmico</a></div></div>
      <section id="container"><ul class="list-unstyled"><div>
        <li class="bid-proposal self"><div id="message-id-1" class="message"><div class="row bid-proposal-header"><div class="col-xs-6"><h4>Propuesta</h4></div><div class="col-xs-6 text-right"><h4><span>USD</span><span class="js-monetary-amount monetary-amount">204,80</span></h4></div></div>
          <div class="bid"><p><span>Monto presupuestado:</span></p></div><article><p class="h4">Descripción</p><p class="content text-wrap js-wysiwyg">O maior desafio de uma série de horror cósmico não é apenas criar criaturas.</p></article><time title="14 Noviembre, 2026 14:30"><span>Hace 23 horas</span></time></div></li>
        <li class="other"><div id="message-id-2" class="message"><article><p class="content text-wrap js-wysiwyg">Olá 👋 obrigado, já tenho a ideia principal e alguns personagens</p></article><time title="15 Noviembre, 2026 10:06"><span>Hace 4 horas</span></time></div></li>
        <li class="self"><div id="message-id-3" class="message"><article><p class="content text-wrap js-wysiwyg">Perfeito! Pode me enviar o material?</p></article><time title="15 Noviembre, 2026 11:57"><span>Hace 2 horas</span></time></div></li>
      </div></ul></section>
      <footer><div class="form-group"><div class="control-group"><textarea id="MessageContent" class="form-control" name="message[content]" placeholder="Responder mensaje" style="width:500px;height:60px"></textarea></div>
        <button id="SubmitMessage" class="btn btn-primary btn-send"><i class="wk2-icon wk2-icon-plane"></i></button></div></footer></div>
    <aside><section class="user-block"><div class="user-info"><a class="h4 user-name" href="https://www.workana.com/e/x"><span>Paula M.</span></a></div></section></aside>
  </div></section>`);
  const wt = readThread("roteirista-horror");
  check("workana: reads li.self/li.other only (not the list on the left)", wt.messages.length === 3 && wt.method === "workana", JSON.stringify(wt.messages).slice(0, 300));
  check("workana: none of the roster names became a message", !wt.messages.some((m) => /Nora|Leo|Iris|Traductor/.test(m.text + m.author)));
  check("workana: mine/theirs", wt.messages.map((m) => m.mine).join() === "true,false,true", wt.messages.map((m) => m.mine).join());
  check("workana: proposal bubble", (wt.messages[0]?.text ?? "").startsWith("📝 Proposal · USD 204,80\nO maior desafio"), wt.messages[0]?.text);
  check("workana: client message + exact time", (wt.messages[1]?.text ?? "").startsWith("Olá 👋 obrigado") && wt.messages[1]?.time === "15 Noviembre, 2026 10:06" && wt.messages[1]?.author === "Paula M.", JSON.stringify(wt.messages[1]));
  check("workana: client name + title", wt.name === "Paula M." && wt.title.startsWith("Roteirista"), `${wt.name} | ${wt.title}`);
  const tl = readThreadList();
  check("header list: 2 conversations with project slugs", tl.items.map((i) => i.slug).join() === "roteirista-horror,disenador-vestuario", JSON.stringify(tl.items).slice(0, 300));
  check("header list: own profile slug", tl.own === "sample-freelancer", String(tl.own));
  check("header list: name, title, preview", tl.items[1]?.name === "Marta" && (tl.items[1]?.title ?? "").startsWith("Diseñador de Vestuario") && tl.items[1]?.snippet.startsWith("Hola Marta"), JSON.stringify(tl.items[1]));
  const bell = readBell();
  check("bell: real notification texts", bell.length === 2 && bell[0].title === "Tu propuesta no fue aceptada" && bell[0].body.startsWith("En Experto en Hotmart"), JSON.stringify(bell));
  check("bell: key ignores 'Ayer' / 'Hace 2 días'", !/Ayer|Hace/.test(bell.map((b) => b.key).join(" ")), bell.map((b) => b.key).join(" || "));
  const cnt = readCounters();
  check("counters: messages 0 (no-messages), bell >= 1", cnt.messages === 0 && (cnt.notifications ?? 0) >= 1, JSON.stringify(cnt));
  let sentText = "";
  document.getElementById("SubmitMessage")!.addEventListener("click", () => {
    const ta = document.getElementById("MessageContent") as HTMLTextAreaElement;
    sentText = ta.value;
    const li = document.createElement("li"); li.className = "self";
    li.innerHTML = `<div class="message"><article><p class="content"></p></article></div>`;
    li.querySelector("p")!.textContent = ta.value;
    document.querySelector("#container ul > div")!.appendChild(li);
    setTimeout(() => { ta.value = ""; }, 150);
  });
  const ws = await sendReply("Claro, pode enviar por aqui.");
  check("workana: reply typed into #MessageContent and sent", ws.ok && !!ws.verified && sentText === "Claro, pode enviar por aqui.", JSON.stringify(ws));

  // 10. No Connects (Friend B's capture): "Place a bid" is href="#" + plan wall; the form URL says Access Denied.
  set(`<main><aside><article class="block-cta"><span><a class="btn btn-primary" href="#" role="button"><span>Place a bid</span></a>
    <div class="modal-plan-wall no-connects" style="display:none"><div class="modal-footer"><a class="btn">Improve your plan</a></div></div></span></article></aside></main>`);
  check("no Connects detected from the plan wall", noConnects({ job_id: "x" }));
  set(`<main><a class="btn" href="/messages/bid/x">Place a bid</a></main>`);
  check("normal job page is not 'no Connects'", !noConnects({ job_id: "x" }));
  set(`<div class="container main"><section class="error-section"><section class="error-box"><div class="error-message"><h2 class="error-title">Access Denied</h2></div></section></section></div>`);
  check("Access Denied page recognised", errorPageTitle() === "Access Denied");

  // 11. Messages without text (the client's voice note in the screenshot), never skipped.
  set(`<section id="container"><ul><div>
    <li class="bid-proposal self"><div class="message"><article><p class="content">Hola, propuesta.</p></article><time title="15 Noviembre, 2026 14:01"></time></div></li>
    <li class="other"><div class="message"><div class="audio-player"><button class="play"></button><span>00:00:00</span></div><time title="15 Noviembre, 2026 15:10"><span>Hace 1 hora</span></time></div></li>
    <li class="other"><div class="message"><div class="unknown-widget"></div><time title="15 Noviembre, 2026 15:11"></time></div></li>
    <li class="other"><div class="message"><article><img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" width="20" height="20"></article></div></li>
  </div></ul></section><aside><section class="user-block"><a class="user-name"><span>Marta</span></a></section></aside>`);
  const mt = readThread("x");
  check("voice message kept as a message", mt.messages.length === 4 && mt.messages[1]?.text.startsWith("🎤 Voice message") && !mt.messages[1]?.mine, JSON.stringify(mt.messages));
  check("text-less unknown message kept", (mt.messages[2]?.text ?? "").startsWith("💬 Message without text"), mt.messages[2]?.text);
  check("image message", (mt.messages[3]?.text ?? "").startsWith("🖼 Image"), mt.messages[3]?.text);
  check("media count reported (for a page capture)", mt.media === 3, String(mt.media));

  document.getElementById("out")!.textContent = JSON.stringify(results);
}

main().catch((e) => { document.getElementById("out")!.textContent = JSON.stringify([{ name: "crash", ok: false, detail: String(e?.stack ?? e) }]); });
