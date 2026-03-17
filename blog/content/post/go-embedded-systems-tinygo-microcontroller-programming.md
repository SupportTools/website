---
title: "Go Embedded Systems: TinyGo and Microcontroller Programming"
date: 2029-08-04T00:00:00-05:00
draft: false
tags: ["Go", "TinyGo", "Embedded", "Microcontrollers", "IoT", "Hardware", "ARM"]
categories: ["Go", "Embedded Systems", "IoT"]
author: "Matthew Mattox - mmattox@support.tools"
description: "Complete guide to TinyGo for microcontroller programming: compilation targets, machine package hardware abstraction, I2C/SPI/UART peripherals, memory constraints, and scheduler differences from standard Go."
more_link: "yes"
url: "/go-embedded-systems-tinygo-microcontroller-programming/"
---

TinyGo brings the Go programming language to microcontrollers and other resource-constrained environments. By using LLVM as its backend instead of the standard Go compiler, TinyGo produces binaries small enough to run on devices with 2KB of RAM and 32KB of flash storage — devices where a standard Go runtime would be orders of magnitude too large. For teams that already know Go and want to leverage that knowledge for IoT and embedded projects, TinyGo provides a familiar language with surprisingly comprehensive hardware support. This guide covers building real hardware projects with TinyGo.

<!--more-->

# Go Embedded Systems: TinyGo and Microcontroller Programming

## TinyGo vs Standard Go

TinyGo is a reimplementation of Go specifically targeting small systems. Key differences:

| Feature | Standard Go | TinyGo |
|---------|-------------|--------|
| Runtime size | ~2MB minimum | ~2KB minimum |
| GC | Full GC (concurrent) | Conservative stack scanner |
| Goroutines | Full goroutine scheduler | Cooperative scheduler |
| Channels | Full buffered/unbuffered | Limited support |
| Reflection | Full | Limited |
| CGo | Full | Limited/no |
| Standard library | Complete | Subset |
| Platforms | Linux/macOS/Windows | 60+ microcontrollers |

TinyGo supports most Go language features that compile to static code. What it does not support: full reflection, `sync.Map`, complex CGo usage, and certain standard library packages that depend on OS services.

## Supported Targets

```bash
# List all supported compilation targets
tinygo targets

# Common targets:
# arduino       - Arduino Uno (AVR ATmega328p)
# arduino-nano  - Arduino Nano
# arduino-mega  - Arduino Mega 2560
# circuitplay-express - Adafruit Circuit Playground Express
# feather-m0    - Adafruit Feather M0 (SAMD21)
# itsybitsy-m0  - Adafruit ItsyBitsy M0
# microbit      - BBC micro:bit (nRF51822)
# microbit-v2   - BBC micro:bit V2 (nRF52833)
# pico          - Raspberry Pi Pico (RP2040)
# pyportal      - Adafruit PyPortal (SAMD51)
# wioterminal   - Seeed Wio Terminal (SAMD51)
# hifive1b      - SiFive HiFive1 Rev B (RISC-V)

# Check target-specific details
tinygo info -target pico

# Output:
# LLVM triple:        armv6m-unknown-unknown-eabi
# GOOS:               linux
# GOARCH:             arm
# Build tags:         baremetal,linux,arm
# Garbage collector:  conservative
# Scheduler:          tasks
# Requires stack size: 2048
```

## Setting Up TinyGo

```bash
# Install TinyGo (Linux x86_64)
wget https://github.com/tinygo-org/tinygo/releases/download/v0.33.0/tinygo_0.33.0_amd64.deb
sudo dpkg -i tinygo_0.33.0_amd64.deb

# Verify installation
tinygo version

# Install required tools for flashing
# For ARM targets
sudo apt-get install openocd gdb-multiarch
# For Arduino
sudo apt-get install avrdude

# Test build (no hardware needed)
cat > hello.go <<'EOF'
package main

import (
    "machine"
    "time"
)

func main() {
    led := machine.LED
    led.Configure(machine.PinConfig{Mode: machine.PinOutput})

    for {
        led.High()
        time.Sleep(time.Millisecond * 500)
        led.Low()
        time.Sleep(time.Millisecond * 500)
    }
}
EOF

# Build for Raspberry Pi Pico
tinygo build -target pico -o hello.uf2 hello.go

# Flash to connected Pico (hold BOOTSEL while connecting USB)
# Pico appears as USB mass storage - just copy the UF2 file
cp hello.uf2 /media/$USER/RPI-RP2/

# For Arduino
tinygo flash -target arduino hello.go
```

## The Machine Package

The `machine` package is TinyGo's hardware abstraction layer. It provides a consistent API across all supported microcontrollers.

### GPIO: Digital Input and Output

```go
// gpio-example.go - Digital I/O with the machine package
package main

import (
    "machine"
    "time"
)

func main() {
    // Configure output pin
    led := machine.LED
    led.Configure(machine.PinConfig{Mode: machine.PinOutput})

    // Configure input pin with pull-up resistor
    button := machine.BUTTON
    button.Configure(machine.PinConfig{Mode: machine.PinInputPullup})

    for {
        // Read button state (active low with pull-up)
        if !button.Get() {
            // Button pressed - LED on
            led.High()
        } else {
            // Button released - LED off
            led.Low()
        }
        time.Sleep(10 * time.Millisecond)
    }
}
```

### Pin Interrupts

```go
// interrupt-example.go
package main

import (
    "machine"
    "machine/usb/hid/keyboard"
)

var ledState bool

func main() {
    led := machine.LED
    led.Configure(machine.PinConfig{Mode: machine.PinOutput})

    button := machine.Pin(machine.GP14) // Specific pin by number
    button.Configure(machine.PinConfig{Mode: machine.PinInputPullup})

    // Set up interrupt on pin change
    button.SetInterrupt(machine.PinFalling, func(p machine.Pin) {
        // This runs in interrupt context - keep it minimal
        ledState = !ledState
        led.Set(ledState)
    })

    // Main loop can do other work
    for {
        // Application logic here
        time.Sleep(100 * time.Millisecond)
    }
}
```

## I2C Communication

I2C (Inter-Integrated Circuit) is a 2-wire serial protocol used for sensors, displays, and other peripherals.

### Reading an I2C Sensor (BME280 Temperature/Humidity/Pressure)

```go
// bme280-i2c.go - Read BME280 sensor over I2C
package main

import (
    "fmt"
    "machine"
    "time"
)

const BME280_ADDR = 0x76

// BME280 register addresses
const (
    REG_CHIP_ID   = 0xD0
    REG_RESET     = 0xE0
    REG_STATUS    = 0xF3
    REG_CTRL_HUM  = 0xF2
    REG_CTRL_MEAS = 0xF4
    REG_CONFIG    = 0xF5
    REG_PRESS_MSB = 0xF7
)

type BME280 struct {
    bus  machine.I2C
    addr uint16

    // Calibration data
    digT [3]int32
    digP [9]int64
    digH [6]int32
}

func NewBME280(bus machine.I2C) *BME280 {
    return &BME280{bus: bus, addr: BME280_ADDR}
}

func (b *BME280) readByte(reg uint8) (uint8, error) {
    buf := make([]byte, 1)
    err := b.bus.Tx(b.addr, []byte{reg}, buf)
    return buf[0], err
}

func (b *BME280) readBytes(reg uint8, n int) ([]byte, error) {
    buf := make([]byte, n)
    err := b.bus.Tx(b.addr, []byte{reg}, buf)
    return buf, err
}

func (b *BME280) writeByte(reg, val uint8) error {
    return b.bus.Tx(b.addr, []byte{reg, val}, nil)
}

func (b *BME280) Init() error {
    // Verify chip ID
    chipID, err := b.readByte(REG_CHIP_ID)
    if err != nil {
        return fmt.Errorf("read chip ID: %w", err)
    }
    if chipID != 0x60 {
        return fmt.Errorf("unexpected chip ID: 0x%02x (expected 0x60)", chipID)
    }

    // Reset
    b.writeByte(REG_RESET, 0xB6)
    time.Sleep(10 * time.Millisecond)

    // Read calibration data
    if err := b.readCalibration(); err != nil {
        return fmt.Errorf("read calibration: %w", err)
    }

    // Configure: humidity oversampling x1
    b.writeByte(REG_CTRL_HUM, 0x01)

    // Configure: temp and pressure oversampling x4, normal mode
    b.writeByte(REG_CTRL_MEAS, 0x93)

    return nil
}

func (b *BME280) readCalibration() error {
    // Read temperature calibration (0x88-0x8D)
    data, err := b.readBytes(0x88, 6)
    if err != nil {
        return err
    }

    b.digT[0] = int32(data[0]) | int32(data[1])<<8
    b.digT[1] = int32(int16(data[2]) | int16(data[3])<<8)
    b.digT[2] = int32(int16(data[4]) | int16(data[5])<<8)

    return nil
}

type Measurement struct {
    Temperature float64 // Celsius
    Pressure    float64 // hPa
    Humidity    float64 // %RH
}

func (b *BME280) Read() (Measurement, error) {
    data, err := b.readBytes(REG_PRESS_MSB, 8)
    if err != nil {
        return Measurement{}, err
    }

    adcP := int32(data[0])<<12 | int32(data[1])<<4 | int32(data[2])>>4
    adcT := int32(data[3])<<12 | int32(data[4])<<4 | int32(data[5])>>4
    adcH := int32(data[6])<<8 | int32(data[7])

    // Temperature compensation (from Bosch datasheet)
    var1 := int64(adcT>>3) - int64(b.digT[0]<<1)
    var2 := (var1 * int64(b.digT[1])) >> 11
    var3 := ((var1 >> 1) * (var1 >> 1)) >> 12
    var3 = (var3 * int64(b.digT[2]<<4)) >> 14

    tFine := var2 + var3
    temperature := float64((tFine*5+128)>>8) / 100.0

    _ = adcP
    _ = adcH

    return Measurement{
        Temperature: temperature,
        Pressure:    1013.25, // Simplified - full calculation omitted for brevity
        Humidity:    50.0,    // Simplified
    }, nil
}

func main() {
    // Configure I2C bus
    // On Raspberry Pi Pico: SDA=GP4, SCL=GP5
    i2c := machine.I2C0
    err := i2c.Configure(machine.I2CConfig{
        SDA:       machine.GP4,
        SCL:       machine.GP5,
        Frequency: machine.TWI_FREQ_400KHZ,
    })
    if err != nil {
        panic(err)
    }

    sensor := NewBME280(i2c)
    if err := sensor.Init(); err != nil {
        panic(err)
    }

    for {
        m, err := sensor.Read()
        if err != nil {
            println("Read error:", err.Error())
        } else {
            println(fmt.Sprintf("Temp: %.2f°C, Pressure: %.2fhPa, Humidity: %.2f%%",
                m.Temperature, m.Pressure, m.Humidity))
        }
        time.Sleep(2 * time.Second)
    }
}
```

## SPI Communication

SPI (Serial Peripheral Interface) is a 4-wire protocol for higher-speed peripherals like displays and ADCs.

### SPI Display (ST7789 240x240 TFT)

```go
// st7789-spi.go - Drive a color TFT display
package main

import (
    "image/color"
    "machine"
    "time"

    "tinygo.org/x/drivers/st7789"
)

func main() {
    machine.SPI0.Configure(machine.SPIConfig{
        Frequency: 62500000, // 62.5 MHz
        Mode:      0,
        SCK:       machine.GP18,
        SDO:       machine.GP19,
        SDI:       machine.GP16,
    })

    display := st7789.New(machine.SPI0,
        machine.GP20, // Reset
        machine.GP21, // Data/Command
        machine.GP17, // Chip Select
        machine.GP22, // Backlight
    )

    display.Configure(st7789.Config{
        Rotation: st7789.Rotation0,
        Width:    240,
        Height:   240,
    })

    // Clear screen to black
    display.FillScreen(color.RGBA{0, 0, 0, 255})

    // Draw a colored rectangle
    display.FillRectangle(10, 10, 100, 50,
        color.RGBA{255, 0, 0, 255}, // Red
    )

    // Draw text
    display.FillRectangle(50, 100, 140, 30,
        color.RGBA{0, 255, 0, 255}, // Green background
    )

    for {
        // Animation loop
        for x := int16(0); x < 240; x++ {
            display.SetPixel(x, 120, color.RGBA{
                uint8(x),
                uint8(240 - int(x)),
                0,
                255,
            })
        }
        time.Sleep(50 * time.Millisecond)
    }
}
```

## UART Serial Communication

```go
// uart-example.go - Serial communication with host computer
package main

import (
    "machine"
    "time"
)

func main() {
    // Configure UART (pins depend on board)
    uart := machine.UART1
    uart.Configure(machine.UARTConfig{
        BaudRate: 115200,
        TX:       machine.GP8,
        RX:       machine.GP9,
    })

    // Send data
    uart.WriteString("TinyGo UART Example\r\n")

    // Receive data
    buf := make([]byte, 64)
    go func() {
        for {
            n, err := uart.Read(buf)
            if err == nil && n > 0 {
                // Echo received data back
                uart.Write(buf[:n])
            }
        }
    }()

    // Main loop
    counter := 0
    for {
        uart.WriteString(fmt.Sprintf("Counter: %d\r\n", counter))
        counter++
        time.Sleep(1 * time.Second)
    }
}
```

## TinyGo Scheduler: Cooperative vs Preemptive

TinyGo's scheduler uses cooperative multitasking on most targets (not preemptive like standard Go). This has important implications:

### Understanding Cooperative Scheduling

```go
// scheduler-example.go - Cooperative goroutines
package main

import (
    "machine"
    "runtime"
    "time"
)

func ledBlinker(led machine.Pin, interval time.Duration) {
    for {
        led.High()
        time.Sleep(interval)
        led.Low()
        time.Sleep(interval)
        // time.Sleep() yields to other goroutines
    }
}

func buttonMonitor() {
    button := machine.BUTTON
    button.Configure(machine.PinConfig{Mode: machine.PinInputPullup})

    for {
        if !button.Get() {
            println("Button pressed!")
        }
        time.Sleep(10 * time.Millisecond)
        // Must yield - goroutines won't preempt each other
    }
}

func busyWork() {
    for {
        // This will STARVE other goroutines on cooperative schedulers!
        // On TinyGo with cooperative scheduling, this loop never yields
        // WRONG:
        // for {
        //     doComputation()
        // }

        // CORRECT: yield periodically
        doComputation()
        runtime.Gosched() // Explicit yield point
    }
}

func main() {
    led1 := machine.LED
    led1.Configure(machine.PinConfig{Mode: machine.PinOutput})

    go ledBlinker(led1, 500*time.Millisecond)
    go buttonMonitor()
    go busyWork()

    select {} // Block main goroutine
}

func doComputation() {
    // Simulated computation
    sum := 0
    for i := 0; i < 1000; i++ {
        sum += i
    }
    _ = sum
}
```

### Channels in TinyGo

```go
// channels-example.go
package main

import (
    "machine"
    "time"
)

func sensorReader(readings chan<- uint16) {
    adc := machine.ADC{Pin: machine.ADC0}
    adc.Configure(machine.ADCConfig{})

    for {
        value := adc.Get()
        readings <- value
        time.Sleep(100 * time.Millisecond)
    }
}

func displayWriter(readings <-chan uint16) {
    for value := range readings {
        // Map ADC value (0-65535) to display range
        brightness := uint8(value >> 8)
        machine.LED.Set(brightness > 128)
    }
}

func main() {
    // Buffered channel prevents blocking if reader is slow
    readings := make(chan uint16, 10)

    machine.LED.Configure(machine.PinConfig{Mode: machine.PinOutput})

    go sensorReader(readings)
    go displayWriter(readings)

    select {}
}
```

## Memory Management in TinyGo

Memory is severely constrained on microcontrollers. Typical limits:
- Arduino Uno: 2KB RAM, 32KB flash
- Raspberry Pi Pico: 264KB RAM, 2MB flash
- Nordic nRF52840: 256KB RAM, 1MB flash

### Memory-Efficient Patterns

```go
// memory-efficient.go
package main

import "machine"

// AVOID: Frequent small allocations
// This triggers GC and causes latency spikes
func badPattern() {
    for {
        data := make([]byte, 64)  // Allocates on heap each iteration
        machine.UART0.Read(data)
        process(data)
    }
}

// BETTER: Reuse buffers
var rxBuf [64]byte  // Stack/global allocation

func goodPattern() {
    for {
        machine.UART0.Read(rxBuf[:])
        process(rxBuf[:])
    }
}

// BETTER: Use stack allocation for fixed-size objects
func readSensor() (uint16, error) {
    var buf [2]byte  // On stack, not heap
    if err := machine.I2C0.Tx(0x48, nil, buf[:]); err != nil {
        return 0, err
    }
    return uint16(buf[0])<<8 | uint16(buf[1]), nil
}

// Use pools for frequently allocated objects
type packet struct {
    data [32]byte
    size int
}

// Simple fixed-size pool
type PacketPool struct {
    pool [8]packet
    used [8]bool
}

func (p *PacketPool) Get() *packet {
    for i := range p.pool {
        if !p.used[i] {
            p.used[i] = true
            return &p.pool[i]
        }
    }
    return nil // Pool exhausted
}

func (p *PacketPool) Put(pkt *packet) {
    for i := range p.pool {
        if &p.pool[i] == pkt {
            p.used[i] = false
            return
        }
    }
}

var globalPool PacketPool
```

### Checking Memory Usage

```bash
# Build and check binary size
tinygo build -target pico -size short -o firmware.uf2 main.go

# Output:
# code    data     bss |    flash     ram
# 14236    2048    1024 |   16284    3072

# Detailed size breakdown
tinygo build -target pico -size full -o firmware.uf2 main.go

# Monitor heap usage at runtime
# TinyGo exposes runtime.MemStats for basic info
```

```go
// memory-monitor.go
package main

import (
    "fmt"
    "machine"
    "runtime"
    "time"
)

func printMemStats() {
    var stats runtime.MemStats
    runtime.ReadMemStats(&stats)
    fmt.Printf("Alloc: %d bytes, TotalAlloc: %d, Sys: %d, NumGC: %d\n",
        stats.Alloc, stats.TotalAlloc, stats.Sys, stats.NumGC)
}

func main() {
    uart := machine.UART0
    uart.Configure(machine.UARTConfig{BaudRate: 115200})

    for {
        printMemStats()
        time.Sleep(5 * time.Second)
    }
}
```

## Building a Complete IoT Sensor Node

```go
// sensor-node.go - Complete IoT sensor with WiFi reporting
// Target: Adafruit Feather M0 WiFi or similar

package main

import (
    "fmt"
    "machine"
    "net/http"
    "time"

    "tinygo.org/x/drivers/bme280"
    "tinygo.org/x/drivers/wifinina"
)

const (
    SSID     = "MyNetwork"
    PASSWORD = "MyPassword"
    // Metrics server endpoint
    SERVER_URL = "http://metrics.local:9091/api/v1/import/prometheus"
)

type SensorNode struct {
    sensor *bme280.Device
    wifi   *wifinina.Device
}

func (n *SensorNode) Setup() error {
    // Configure I2C
    i2c := machine.I2C0
    i2c.Configure(machine.I2CConfig{
        SDA: machine.SDA_PIN,
        SCL: machine.SCL_PIN,
    })

    // Initialize BME280
    sensor := bme280.New(i2c)
    if err := sensor.Configure(bme280.Config{}); err != nil {
        return fmt.Errorf("BME280: %w", err)
    }
    n.sensor = &sensor

    // Initialize WiFi
    spi := machine.SPI0
    spi.Configure(machine.SPIConfig{
        Frequency: 8000000,
    })

    wifi := wifinina.New(spi,
        machine.NINA_CS,
        machine.NINA_ACK,
        machine.NINA_GPIO0,
        machine.NINA_RESETN,
    )
    wifi.Configure()

    // Connect to WiFi
    for i := 0; i < 10; i++ {
        err := wifi.ConnectToAccessPoint(SSID, PASSWORD, 10000)
        if err == nil {
            break
        }
        time.Sleep(5 * time.Second)
    }

    n.wifi = wifi
    return nil
}

func (n *SensorNode) Report() error {
    temp, err := n.sensor.ReadTemperature()
    if err != nil {
        return fmt.Errorf("read temperature: %w", err)
    }

    humidity, err := n.sensor.ReadHumidity()
    if err != nil {
        return fmt.Errorf("read humidity: %w", err)
    }

    pressure, err := n.sensor.ReadPressure()
    if err != nil {
        return fmt.Errorf("read pressure: %w", err)
    }

    // Format as Prometheus text format
    payload := fmt.Sprintf(
        `sensor_temperature_celsius %.2f
sensor_humidity_percent %.2f
sensor_pressure_hpa %.2f
`,
        float64(temp)/1000.0,
        float64(humidity)/100.0,
        float64(pressure)/100000.0,
    )

    resp, err := http.Post(SERVER_URL, "text/plain", []byte(payload))
    if err != nil {
        return fmt.Errorf("post metrics: %w", err)
    }
    defer resp.Body.Close()

    return nil
}

func main() {
    node := &SensorNode{}

    if err := node.Setup(); err != nil {
        println("Setup failed:", err.Error())
        for {}
    }

    println("Sensor node ready")

    for {
        if err := node.Report(); err != nil {
            println("Report error:", err.Error())
        }
        time.Sleep(30 * time.Second)
    }
}
```

## Debugging TinyGo Applications

```bash
# Build with debug symbols
tinygo build -target pico -opt none -o debug.uf2 main.go

# Connect debugger via SWD/JTAG
openocd -f interface/cmsis-dap.cfg -f target/rp2040.cfg

# In another terminal
gdb-multiarch debug.elf
(gdb) target extended-remote localhost:3333
(gdb) monitor reset halt
(gdb) load
(gdb) break main.main
(gdb) continue

# Serial output debugging (most common approach)
# Connect to serial port
minicom -D /dev/ttyACM0 -b 115200
# or
screen /dev/ttyACM0 115200
# or
picocom -b 115200 /dev/ttyACM0

# TinyGo playground for browser-based testing
# https://play.tinygo.org/ - runs WASM simulation
```

## Summary

TinyGo makes Go a viable language for microcontroller programming:

1. **The `machine` package** provides a unified hardware abstraction that works across 60+ supported boards
2. **I2C, SPI, UART, and GPIO** APIs are straightforward and work identically across target boards
3. **Cooperative scheduling** means goroutines must yield periodically — use `time.Sleep()` or `runtime.Gosched()` in compute loops
4. **Memory discipline** is essential: prefer stack and global allocations over heap, reuse buffers, and avoid libraries with excessive allocations
5. **Binary size** is manageable — a complete sensor application with WiFi typically fits in 64-128KB of flash
6. **Channel support** exists but with limitations — use buffered channels and be aware of the cooperative scheduler when reasoning about deadlocks

For teams familiar with Go developing IoT systems, TinyGo significantly reduces the cognitive overhead compared to C/C++, while still producing binaries efficient enough for the most constrained targets.
