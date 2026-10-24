# 🛡️ GasGuard Pro v2.0 
### *Sistema Inteligente de Monitoreo Ambiental y Detección de Fugas de Gas* 🚀

<p align="center">
  <img src="https://img.shields.io/badge/STATUS-OPERATIVO_%F0%9F%94%A5-success?style=for-the-badge&logo=none" alt="Status">
  <img src="https://img.shields.io/badge/HARDWARE-ARDUINO-00979D?style=for-the-badge&logo=arduino&logoColor=white" alt="Arduino">
  <img src="https://img.shields.io/badge/FRONTEND-HTML5_%7C_CSS3_%7C_JS-orange?style=for-the-badge" alt="Tech">
  <img src="https://img.shields.io/badge/CONEXI%C3%93N-WEB_SERIAL_API-purple?style=for-the-badge" alt="WebSerial">
  <img src="https://img.shields.io/badge/MODO-100%25_OFFLINE-blue?style=for-the-badge" alt="Offline">
</p>

---

## 📖 Acerca del Proyecto

**GasGuard Pro** es una solución integral de seguridad ambiental desarrollada para la detección temprana de gases nocivos en espacios cerrados. Combina hardware de bajo costo (**Arduino** y sensor **MQ-135**) con una interfaz gráfica web moderna de alto rendimiento impulsada por la **Web Serial API**. 

Diseñado específicamente para operar de forma autónoma y sin dependencias de internet (ideal para entornos educativos como las netbooks del gobierno *Juana Manso*), el sistema procesa alertas en tiempo real, activa alarmas sonoras/lumínicas y registra un historial completo con gráficos dinámicos.

---

## ✨ Características Principales

* **🔌 Conexión USB Directa (Nativa):** Comunicación bidireccional instantánea entre la placa y el navegador mediante la *Web Serial API* (compatible con Google Chrome y Microsoft Edge).
* **🚦 Sistema Tri-Estado de Alerta Inteligente:**
  * 🛡️ **Seguro:** Monitoreo activo con aire limpio y ambiente optimizado.
  * ⚠️ **Precaución:** Elevación moderada de parámetros; activación de protocolos preventivos y ventilación.
  * 🚨 **Peligro Crítico:** Disparador de sirena estilo ambulancia ("I-O"), luces intermitentes en placa y panel interactivo de evacuación.
* **📈 Gráfico de Tendencias en Tiempo Real:** Renderizado dinámico de datos mediante HTML5 `<canvas>` sin librerías externas pesadas.
* **📜 Ventana Modal de Historial Completo:** Registro estructurado por fecha, hora exacta, valor en PPM y nivel de riesgo con opción de borrado seguro.
* **🏫 100% Offline-First:** Arquitectura basada en Emojis y estilos nativos para garantizar una carga instantánea y funcionamiento total sin red Wi-Fi.

---

## 🛠️ Stack Tecnológico y Hardware

| Capa | Componente / Tecnología | Descripción |
| :--- | :--- | :--- |
| **Microcontrolador** | Arduino (Uno / Nano / Mega) | Procesamiento de señales analógicas del sensor y control de actuadores. |
| **Sensor** | MQ-135 | Detección analógica de gases contaminantes y calidad del aire ($A0$). |
| **Actuadores** | Buzzer (3 pines) + LED Amarillo | Emisión de alerta acústica modulada y destellos lumínicos. |
| **Interfaz Web** | HTML5, CSS3 (Variables, Grid/Flexbox) | Estructura responsiva y diseño futurista en modo oscuro. |
| **Lógica Frontend** | JavaScript (Vanilla / ES6+) | Gestión de streams seriales, gráficos y manejo de modales. |

---

## ⚡ Esquema de Conexiones Físicas

```text
[Arduino UNO / Nano]
  ├── 5V  ─────────────── VCC (Sensor MQ-135 & Buzzer)
  ├── GND ─────────────── GND (Sensor, Buzzer & Cátodo LED)
  ├── A0  ─────────────── AO  (Salida Analógica MQ-135)
  ├── D8  ─────────────── S   (Señal Buzzer)
  └── D7  ─────────────── Resistencia 220Ω ── Anónimo LED Amarillo
