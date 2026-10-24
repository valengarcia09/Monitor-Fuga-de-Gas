// ===== Configuración =====
const UMBRAL = 400;          // Debe ser igual a "umbralGas" en el sketch del Arduino
const TIMEOUT_MS = 4000;     // Si pasan 4 s sin datos, se avisa "sin señal"
const SIMULACION_MS = 10000; // Con el Arduino conectado, la simulación pausa los datos reales 10 s
const ESPERA_MS = 5 * 60 * 1000; // Tras una fuga, se pide esperar unos minutos más antes de volver a entrar
const historialDatos = [];
const MAX_PUNTOS_GRAFICO = 30;
const NIVEL_PRECAUCION = UMBRAL * 0.75; // Franja ámbar: a partir de este valor se avisa precaución
const HISTORIAL_MAX_EVENTOS = 100;
const HISTORIAL_LS = "gasguard_historial_v1";

// ===== Alerta por WhatsApp (CallMeBot) =====
// Para activarla, una sola vez:
//   1) Guardá en tus contactos el número +34 621 33 11 709 (bot de CallMeBot)
//   2) Mandale ese mensaje exacto: "I allow callmebot to send me messages"
//   3) Te responde con una apikey: pegala aquí abajo junto a TU número
const ALERTA_WSP = {
    destino: "+549XXXXXXXXXX",   // ← Tu teléfono con código país (ej: +5491123456789)
    apikey: "ACA_VA_TU_APIKEY",  // ← La que te devuelve CallMeBot
    recordatorioMs: 5 * 60 * 1000 // Si la fuga sigue activa, reavisa cada 5 minutos
};

let port;
let reader;
let readableStreamClosed;
let keepReading = false;
let watchdog;
let simulacionHasta = 0;
let ultimaFuga = 0;
let nivelActual = "idle";       // idle | peligro | precaucion | espera | tranqui
let ultimoNivelRegistrado = null;
let historicoEventos = [];
let beepActivo = false;
let beepTimer = null;
let audioCtx = null;
let tituloBase = document.title || "GasGuard Pro";

// El historial de eventos sobrevive al cierre de la pestaña
try {
    const guardado = JSON.parse(localStorage.getItem(HISTORIAL_LS));
    if (Array.isArray(guardado)) historicoEventos = guardado.slice(-HISTORIAL_MAX_EVENTOS);
} catch (e) { /* localStorage bloqueado: se usa solo la memoria */ }

const $ = (id) => document.getElementById(id);

function actualizarHora() {
    $('lastUpdate').innerText = new Date().toLocaleTimeString();
}

// ===== Tarjeta de estado =====
function setTarjeta(clase, icono, titulo, mensaje) {
    $('statusCard').className = 'main-card ' + clase;
    $('statusIcon').innerText = icono;
    $('statusText').innerText = titulo;
    $('statusMsg').innerText = mensaje;
}

// ===== Título dinámico de la pestaña =====
function actualizarTituloPestana(estado) {
    if (estado === 'peligro') document.title = "🚨 ¡ALERTA DE FUGA! — " + tituloBase;
    else if (estado === 'precaucion') document.title = "⚠️ Nivel subiendo — " + tituloBase;
    else if (estado === 'sin-senal') document.title = "📡 Sin señal — " + tituloBase;
    else if (estado === 'idle') document.title = tituloBase;
    else document.title = "😌 Aire normal — " + tituloBase;
}

// ===== Beep del navegador (opcional, OFF por defecto) =====
function alternarBeepNavegador() {
    beepActivo = !beepActivo;
    const btn = $('btnBeep');
    if (btn) btn.innerText = beepActivo ? "🔔 Aviso sonoro del navegador: ON" : "🔔 Aviso sonoro del navegador: OFF";

    if (beepActivo) {
        audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
        if (audioCtx.state === 'suspended') audioCtx.resume();
        if (!beepTimer) iniciarBeeps();
    } else {
        detenerBeeps();
    }
}

function iniciarBeeps() {
    beepTimer = setInterval(() => {
        if (!beepActivo || nivelActual !== 'peligro' || !audioCtx) return;
        const t = audioCtx.currentTime;
        pitido(t);
        pitido(t + 0.22); // doble pitido estilo alarma
    }, 800);
}

function pitido(cuando) {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'square';
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.08, cuando);
    gain.gain.exponentialRampToValueAtTime(0.0001, cuando + 0.14);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start(cuando);
    osc.stop(cuando + 0.15);
}

function detenerBeeps() {
    clearInterval(beepTimer);
    beepTimer = null;
}

// Muestra u oculta todo lo que aparece durante una fuga
function setModoFuga(activo) {
    const guia = $('leakGuide');
    const yaVisible = guia.classList.contains('visible');

    $('actionAlertPanel').classList.toggle('visible', activo);
    guia.classList.toggle('visible', activo);
    document.body.classList.toggle('leak-mode', activo);

    // Solo desplaza la pantalla la primera vez que aparece la guía
    if (activo && !yaVisible) {
        guia.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
}

// ===== Control de "sin señal" =====
function reiniciarWatchdog() {
    clearTimeout(watchdog);
    watchdog = setTimeout(mostrarSinSenal, TIMEOUT_MS);
}

function mostrarSinSenal() {
    setTarjeta('status-danger', 'sensors_off', '📡 SIN SEÑAL DEL SENSOR',
        'No llegan datos del Arduino. Revisá el cable y la alimentación 🔧');
    $('ppmProgress').className = 'progress-fill fill-danger';
    $('actionAlertPanel').classList.remove('visible');
    actualizarTituloPestana('sin-senal');
    // La guía de emergencia no se oculta: si había una fuga, sigue siendo útil
}

// Estado neutral cuando no hay puerto conectado
function mostrarInactivo() {
    setTarjeta('status-idle', 'power_off', '🔌 SIN CONEXIÓN',
        'Conectá tu Arduino para empezar a cuidar el aire 💨');
    $('ppmValue').innerText = '--';
    $('ppmProgress').style.width = '5%';
    $('ppmProgress').className = 'progress-fill fill-safe';
    actualizarTituloPestana('idle');
    setModoFuga(false);
}

// ===== Historial: puntos para el gráfico + eventos con fecha (persistente) =====
function guardarPunto(valor) {
    historialDatos.push({ v: valor, p: nivelActual === 'peligro' });
    if (historialDatos.length > 120) historialDatos.shift();
}

function registrarEvento(valor, nivel) {
    const loggable = nivel === 'peligro' || nivel === 'precaucion' || nivel === 'tranqui';
    if (!loggable) return;

    historicoEventos.push({
        f: new Date().toISOString(),
        v: valor,
        n: nivel
    });
    if (historicoEventos.length > HISTORIAL_MAX_EVENTOS) historicoEventos.shift();
    guardarHistorial();
}

function guardarHistorial() {
    try {
        localStorage.setItem(HISTORIAL_LS, JSON.stringify(historicoEventos.slice(-HISTORIAL_MAX_EVENTOS)));
    } catch (e) { /* sin storage: solo en memoria */ }
}

// Dibuja un canvas con la serie de puntos, la línea del umbral y etíquetas mínimas
function dibujarSerie(canvas, puntos, altura) {
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    // Fallback 512: algunas pestañas en segundo plano reportan ancho 0
    const ancho = canvas.clientWidth || 512;

    canvas.width = ancho * dpr;
    canvas.height = altura * dpr;

    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, ancho, altura);

    const margen = 6;
    const h = altura - margen * 2;
    const yDe = (v) => margen + h - Math.min(v / 1023, 1) * h;

    // Línea del umbral
    const yU = yDe(UMBRAL);
    ctx.strokeStyle = 'rgba(244, 63, 94, 0.45)';
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(0, yU);
    ctx.lineTo(ancho, yU);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = 'rgba(244, 63, 94, 0.75)';
    ctx.font = '9px Inter, sans-serif';
    ctx.fillText('umbral', 4, yU - 3);

    // Línea de precaución
    const yP = yDe(NIVEL_PRECAUCION);
    ctx.strokeStyle = 'rgba(250, 204, 21, 0.35)';
    ctx.setLineDash([3, 5]);
    ctx.beginPath();
    ctx.moveTo(0, yP);
    ctx.lineTo(ancho, yP);
    ctx.stroke();
    ctx.setLineDash([]);

    if (!puntos.length) return;

    // Relleno bajo la curva
    const paso = ancho / Math.max(puntos.length - 1, 1);
    const nivelFinal = nivelActual;
    const color = nivelFinal === 'peligro' ? '#f43f5e'
        : nivelFinal === 'precaucion' ? '#facc15' : '#10b981';

    ctx.beginPath();
    puntos.forEach((pto, i) => {
        const x = i * paso;
        i === 0 ? ctx.moveTo(0, yDe(pto.v)) : ctx.lineTo(x, yDe(pto.v));
    });
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.8;
    ctx.lineJoin = 'round';
    ctx.stroke();

    // Punto del último valor
    const ultimo = puntos[puntos.length - 1];
    ctx.beginPath();
    ctx.arc((puntos.length - 1) * paso, yDe(ultimo.v), 2.6, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
}

function dibujarEnVivo() {
    dibujarSerie($('graficoEnVivo'), historialDatos.slice(-MAX_PUNTOS_GRAFICO), 64);
}

function dibujarGraficoModal() {
    dibujarSerie($('graficoHistorial'), historialDatos.slice(-120), 150);
}

function abrirHistorialModal() {
    renderizarTablaHistorial();
    dibujarGraficoModal();
    $('historyModal').classList.add('visible');
}

function cerrarHistorialModal() {
    $('historyModal').classList.remove('visible');
}

function limpiarHistorial() {
    historicoEventos.length = 0;
    historialDatos.length = 0;
    ultimoNivelRegistrado = null;
    try { localStorage.removeItem(HISTORIAL_LS); } catch (e) {}
    renderizarTablaHistorial();
    dibujarGraficoModal();
    dibujarEnVivo();
}

function renderizarTablaHistorial() {
    const cuerpo = $('cuerpoHistorial');
    if (!cuerpo) return;

    if (!historicoEventos.length) {
        cuerpo.innerHTML = '<tr><td colspan="4" class="vacio-historial">Aún no hay eventos registrados 📭</td></tr>';
        return;
    }

    cuerpo.innerHTML = historicoEventos.slice().reverse().map(ev => {
        const fecha = new Date(ev.f);
        const nivel = ev.n === 'peligro' ? '<span class="nivel-pill nivel-peligro">🚨 peligro</span>'
            : ev.n === 'precaucion' ? '<span class="nivel-pill nivel-precaucion">⚠️ precaución</span>'
            : '<span class="nivel-pill nivel-tranqui">😌 normal</span>';
        return '<tr>'
            + '<td>' + fecha.toLocaleDateString('es-AR') + '</td>'
            + '<td>' + fecha.toLocaleTimeString('es-AR') + '</td>'
            + '<td>' + ev.v + '</td>'
            + '<td>' + nivel + '</td>'
            + '</tr>';
    }).join('');
}

// ===== Conexión con el Arduino =====
async function conectarArduino() {
    if (!('serial' in navigator)) {
        alert("Tu navegador no soporta Web Serial. Usá Google Chrome o Microsoft Edge.");
        return;
    }

    try {
        port = await navigator.serial.requestPort();
        await port.open({ baudRate: 9600 }); // Igual que Serial.begin(9600)
    } catch (error) {
        console.error("No se pudo abrir el puerto:", error);
        port = null;
        return;
    }

    $('connectionBadge').className = 'badge badge-connected';
    $('connectionBadge').innerHTML = '<span class="dot"></span> En línea (USB)';

    const btn = $('btnConectar');
    btn.innerText = '⏏️ Desconectar puerto';
    btn.style.background = '#ef4444';
    btn.onclick = desconectarArduino;

    $('sourceSub').innerText = '📡 Puerto serie USB';
    setTarjeta('status-idle', 'hourglass_top', '⏳ ESPERANDO DATOS',
        'Conectado. Esperando la primera lectura del sensor…');

    keepReading = true;
    const textDecoder = new TextDecoderStream();
    readableStreamClosed = port.readable.pipeTo(textDecoder.writable);
    reader = textDecoder.readable.getReader();
    reiniciarWatchdog();

    let buffer = "";
    try {
        while (keepReading) {
            const { value, done } = await reader.read();
            if (done) break;
            if (value) {
                buffer += value;
                let lines = buffer.split('\n');
                buffer = lines.pop();
                for (let line of lines) {
                    procesarDatoSerial(line.trim());
                }
            }
        }
    } catch (error) {
        console.error("Error de lectura:", error);
    } finally {
        await desconectarArduino();
    }
}

async function desconectarArduino() {
    if (!port) return; // Ya estaba desconectado
    const puertoActual = port;
    port = null;
    keepReading = false;
    clearTimeout(watchdog);

    try { if (reader) await reader.cancel(); } catch (e) { /* ya cerrado */ }
    try { if (readableStreamClosed) await readableStreamClosed; } catch (e) { /* esperado al cancelar */ }
    try { await puertoActual.close(); } catch (e) { console.error("Error al cerrar:", e); }

    reader = null;
    readableStreamClosed = null;

    $('connectionBadge').className = 'badge badge-disconnected';
    $('connectionBadge').innerHTML = '<span class="dot"></span> Desconectado';

    const btn = $('btnConectar');
    btn.innerText = '🔌 Conectar Arduino (USB)';
    btn.style.background = '';
    btn.onclick = conectarArduino;

    $('sourceSub').innerText = 'Esperando puerto USB';
    mostrarInactivo();
}

// Si se desenchufa el cable USB
if ('serial' in navigator) {
    navigator.serial.addEventListener('disconnect', desconectarArduino);
}

// ===== Lectura de datos =====
// El Arduino envía líneas como: "Nivel de gas: 450"
function procesarDatoSerial(texto) {
    const coincidencia = texto.match(/\d+/);   // Busca el primer número de la línea
    if (!coincidencia) return;

    reiniciarWatchdog();

    // Si se está simulando, los datos reales esperan unos segundos
    if (Date.now() < simulacionHasta) return;

    const valor = parseInt(coincidencia[0], 10);
    actualizarPantalla(valor, valor > UMBRAL, '📡 Puerto serie USB');
}

// ===== Alerta por WhatsApp =====
function alertaConfigurada() {
    return /^\+\d{10,15}$/.test(ALERTA_WSP.destino)
        && /^[\w-]{6,}$/.test(ALERTA_WSP.apikey)
        && ALERTA_WSP.apikey !== "ACA_VA_TU_APIKEY";
}

// Envía el mensaje vía CallMeBot. mode "no-cors": el pedido parte igual
// aunque el servidor no permita leer la respuesta desde el navegador.
function mandarWhatsApp(texto) {
    if (!alertaConfigurada()) {
        console.warn("⚠️ Alerta WhatsApp sin configurar: completá ALERTA_WSP al inicio de java.js");
        return false;
    }
    const url = "https://api.callmebot.com/whatsapp.php"
        + "?phone=" + encodeURIComponent(ALERTA_WSP.destino)
        + "&text=" + encodeURIComponent(texto)
        + "&apikey=" + encodeURIComponent(ALERTA_WSP.apikey);

    fetch(url, { mode: "no-cors" })
        .then(() => console.log("📱 Alerta WhatsApp enviada"))
        .catch(err => console.error("No se pudo enviar la alerta WhatsApp:", err));
    return true;
}

let fugaNotificada = false;   // ¿ya se mandó la alerta inicial de ESTA fuga?
let recordatorioFuga = null;  // recordatorio periódico mientras la fuga continúa

function detenerRecordatorio() {
    clearInterval(recordatorioFuga);
    recordatorioFuga = null;
}

// Primera alerta de la fuga + recordatorios hasta que cesen los datos peligrosos
function notificarFuga(valor, simulada) {
    const hora = new Date().toLocaleTimeString("es-AR");
    const origen = simulada ? "\n🧪 (mensaje generado por el modo simulación)" : "";
    const texto =
        "🚨 ALARMA GasGuard Pro" + origen +
        "\nFuga de gas detectada a las " + hora + "." +
        "\nNivel del sensor: " + valor + "/1023." +
        "\nVentilá, cerrá la llave y salí de la casa." +
        "\nDesde afuera llamá al 100 (Bomberos).";

    mandarWhatsApp(texto);
    if ($('tag-wsp')) $('tag-wsp').hidden = false;

    if (!alertaConfigurada()) return; // sin config: no programar recordatorios

    detenerRecordatorio();
    recordatorioFuga = setInterval(() => {
        mandarWhatsApp("⏰ GasGuard Pro: la fuga de gas SIGUE detectada a las " +
            new Date().toLocaleTimeString("es-AR") + ". Ventilá y salí del lugar.");
    }, ALERTA_WSP.recordatorioMs);
}

// El sensor vuelve a valores normales tras una fuga notificada
function avisarFinDeFuga(simulada) {
    detenerRecordatorio();
    const hora = new Date().toLocaleTimeString("es-AR");
    mandarWhatsApp("🟢 GasGuard Pro: el nivel de gas vuelve a valores normales a las " + hora +
        ". Igual esperá unos minutos y ventilá bien antes de volver a entrar." +
        (simulada ? "\n🧪 (modo simulación)" : ""));
}

// Botón de prueba: envía un WhatsApp aunque no haya fuga
function probarAlertaWhatsApp() {
    const btn = $('btnWsp');
    const enviado = mandarWhatsApp("🧪 Prueba GasGuard Pro: si este mensaje te llegó, tu alerta por WhatsApp funciona correcto ✔ " +
        new Date().toLocaleTimeString("es-AR"));

    if (!btn) return;
    btn.innerText = enviado ? "✅ Enviado — revisá tu WhatsApp" : "⚠️ Sin configure — editá ALERTA_WSP en java.js";
    setTimeout(() => { btn.innerText = "📱 Probar alerta WhatsApp"; }, 3000);
}

// ===== Simulador =====
function simularEstado(tipo) {
    simulacionHasta = Date.now() + SIMULACION_MS;

    // Badge de modo demo mientras dure la simulación
    const badge = $('connectionBadge');
    badge.className = 'badge badge-demo';
    badge.innerHTML = '<span class="dot"></span> 🧪 Modo demo';
    setTimeout(() => {
        if (Date.now() < simulacionHasta) return; // otra simulación en curso
        const conectado = !!port;
        badge.className = conectado ? 'badge badge-connected' : 'badge badge-disconnected';
        badge.innerHTML = conectado
            ? '<span class="dot"></span> En línea (USB)'
            : '<span class="dot"></span> Desconectado';
    }, SIMULACION_MS);

    if (tipo === 'peligro') {
        const valor = 750 + Math.floor(Math.random() * 200); // entre 750 y 949
        actualizarPantalla(valor, true, '🧪 Modo simulación');
    } else {
        const valor = 80 + Math.floor(Math.random() * 100);  // entre 80 y 179
        actualizarPantalla(valor, false, '🧪 Modo simulación');
    }
}

// ===== Actualización de la pantalla =====
function actualizarPantalla(valor, esPeligro, fuente) {
    actualizarHora();
    $('ppmValue').innerText = valor;
    $('sourceSub').innerText = fuente;
    const simulada = fuente && fuente.includes('simulación');

    // analogRead entrega valores de 0 a 1023
    const porcentaje = Math.min(Math.max((valor / 1023) * 100, 5), 100);
    $('ppmProgress').style.width = porcentaje + '%';

    // Niveles: peligro > precaución > espera (post-fuga) > tranqui
    const esPrecaucion = !esPeligro && valor >= NIVEL_PRECAUCION;
    let nivel;
    if (esPeligro) nivel = 'peligro';
    else if (esPrecaucion) nivel = 'precaucion';
    else if (Date.now() - ultimaFuga < ESPERA_MS) nivel = 'espera';
    else nivel = 'tranqui';

    guardarPunto(valor);
    if (nivel !== nivelActual) {
        registrarEvento(valor, nivel);
        nivelActual = nivel;
    }

    if (esPeligro) {
        ultimaFuga = Date.now();
        setTarjeta('status-danger', 'warning', '🚨 ¡ALERTA DE FUGA!',
            'Mantené la calma y seguí los pasos de abajo 👇');
        $('ppmProgress').className = 'progress-fill fill-danger';

        // Alerta por WhatsApp: solo al INICIO de la fuga (anti-spam)
        if (!fugaNotificada) {
            fugaNotificada = true;
            notificarFuga(valor, simulada);
        }
    } else if (esPrecaucion) {
        setTarjeta('status-warn', 'warning_amber', '⚠️ NIVEL DE GAS SUBIENDO',
            'Se acerca al umbral de alerta. Ventilá la habitación por las dudas 💨');
        $('ppmProgress').className = 'progress-fill fill-warn';
    } else if (nivel === 'espera') {
        // Los valores ya bajaron, pero se pide paciencia antes de volver a entrar
        setTarjeta('status-safe', 'hourglass_top', '✅ VALORES NORMALES',
            'Esperá unos minutos más y ventilá bien antes de volver a entrar ⏳');
        $('ppmProgress').className = 'progress-fill fill-safe';
    } else {
        setTarjeta('status-safe', 'verified_user', '😌 TODO TRANQUI',
            'Aire limpio, podés respirar tranquilo 🌿');
        $('ppmProgress').className = 'progress-fill fill-safe';
    }

    // Fin de la fuga notificada: aviso por WhatsApp apenas retorna la calma
    if (!esPeligro && fugaNotificada) {
        fugaNotificada = false;
        avisarFinDeFuga(simulada);
    }

    setModoFuga(esPeligro);
    actualizarTituloPestana(nivel);
    dibujarEnVivo();
}

// ===== Arranque =====
(function iniciar() {
    // Marca visual del umbral sobre la barra de progreso
    const barra = document.querySelector('.progress-bar');
    if (barra) barra.style.setProperty('--umbral-left', ((UMBRAL / 1023) * 100).toFixed(1) + '%');

    // La tecla Escape cierra el historial
    window.addEventListener('keydown', ev => {
        if (ev.key === 'Escape') cerrarHistorialModal();
    });
})();