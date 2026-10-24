// ===== Configuración =====
const UMBRAL = 400;          // Debe ser igual a "umbralGas" en el sketch del Arduino
const TIMEOUT_MS = 4000;     // Si pasan 4 s sin datos, se avisa "sin señal"
const SIMULACION_MS = 10000; // Con el Arduino conectado, la simulación pausa los datos reales 10 s
const ESPERA_MS = 5 * 60 * 1000; // Tras una fuga, se pide esperar unos minutos más antes de volver a entrar
const historialDatos = [];
const MAX_PUNTOS_GRAFICO = 30;

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

    // analogRead entrega valores de 0 a 1023
    const porcentaje = Math.min(Math.max((valor / 1023) * 100, 5), 100);
    $('ppmProgress').style.width = porcentaje + '%';

    if (esPeligro) {
        ultimaFuga = Date.now();
        setTarjeta('status-danger', 'warning', '🚨 ¡ALERTA DE FUGA!',
            'Mantené la calma y seguí los pasos de abajo 👇');
        $('ppmProgress').className = 'progress-fill fill-danger';
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

    setModoFuga(esPeligro);
}