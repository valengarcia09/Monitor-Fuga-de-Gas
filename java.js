// ===== Configuración =====
const UMBRAL = 400;          // Debe ser igual a "umbralGas" en el sketch del Arduino
const TIMEOUT_MS = 4000;     // Si pasan 4 s sin datos, se avisa "sin señal"
const SIMULACION_MS = 10000; // Con el Arduino conectado, la simulación pausa los datos reales 10 s
const ESPERA_MS = 5 * 60 * 1000; // Tras una fuga, se pide esperar unos minutos más antes de volver a entrar
const historialDatos = [];
const MAX_PUNTOS_GRAFICO = 30;

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
    // La guía de emergencia no se oculta: si había una fuga, sigue siendo útil
}

// Estado neutral cuando no hay puerto conectado
function mostrarInactivo() {
    setTarjeta('status-idle', 'power_off', '🔌 SIN CONEXIÓN',
        'Conectá tu Arduino para empezar a cuidar el aire 💨');
    $('ppmValue').innerText = '--';
    $('ppmProgress').style.width = '5%';
    $('ppmProgress').className = 'progress-fill fill-safe';
    setModoFuga(false);
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
    } else if (Date.now() - ultimaFuga < ESPERA_MS) {
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
}