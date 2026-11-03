# FIFO Fiscal

Calcula el FIFO y prepara el IRPF de bolsa y criptomonedas según los criterios de la AEAT y la DGT, con DEGIRO, Trade Republic, Kraken, Revolut y Coinbase. Funciona solo en tu equipo: los datos se guardan en `data/fifo.db` y el servidor únicamente acepta conexiones locales. Solo sale a internet para los tipos de cambio del BCE, los precios de Kraken y, si lo pides, los precios de Yahoo. A Yahoo se envían ISIN y símbolos, nunca cantidades ni importes.

> Es un apoyo de cálculo, no asesoramiento fiscal. Revisa el resultado en Renta Web. Los criterios y sus fuentes están en [docs/criterios.md](docs/criterios.md).

## Arrancar

Requiere [Node 24](https://nodejs.org) o posterior.

```bash
git clone <dirección de este repositorio>
cd fifo-fiscal
npm install
npm start
```

Se abre en <http://127.0.0.1:5199>. Para desarrollar, `npm run dev`. Para las pruebas, `npm test`.

Cada persona tiene sus propios datos: se guardan en `data/`, que git ignora, y nunca se suben al repositorio. No dejes extractos ni tu base de datos fuera de esa carpeta si vas a contribuir con cambios. Para actualizar, `git pull` y `npm install`; tus datos se conservan.

Al empezar, en **Ajustes**, indica tu última renta presentada: lo anterior no se vuelve a calcular.

## Cómo se usa

La barra lateral sigue tres pasos:

1. **Subir datos**: arrastra los CSV. El bróker y el formato se detectan solos. Sube toda la historia desde tu primera compra, porque el FIFO la necesita.
   - DEGIRO: `Transactions` y `Account`.
   - Trade Republic: «Exportación de transacciones».
   - Kraken: `Ledgers`, no `Trades`.
   - Revolut: el extracto de cuenta de Inversiones y el de Cripto. No da ISIN: si tienes un valor también en otro bróker, escríbelo en Ajustes.
   - Coinbase: «Transaction history», desde el principio.
2. **Revisar**: te dice lo que falta y lo que conviene comprobar, agrupado y con un botón para cada cosa.
3. **Mi Renta**: copia cada importe a su casilla con un clic y marca lo que ya has pasado a Renta Web. También exporta a Excel o PDF.

Para consultar: **Movimientos** (el extracto completo, donde se edita y se añade), **Cartera** (qué tienes, cuánto vale hoy con precios de Yahoo y en qué orden se venderá), **Resultados** (ventas, dividendos e intereses), **Desempeño** (lo ganado o perdido de verdad cada año, con gráficas) y **¿Y si vendo?** (una barra por cada activo para ver al momento lo que pagarías, sin guardar nada).

Reimportar un fichero es seguro: lo repetido se ignora y tus ediciones se conservan.

## Edición y cuadre

Cada movimiento se abre como un recibo. Se puede editar cantidad, precio, importe, tipo de cambio, comisión, otros gastos y total, y solo se guarda si cuadra:

```
Cantidad × Precio                   = Importe en divisa
Importe en divisa ÷ Tipo de cambio  = Importe en EUR
Importe EUR ± Comisión ± Otros      = Total
```

- **Calcular solo** (activo por defecto): cada cambio se propaga y se resalta lo que cambia. Un total distinto lo absorbe la comisión; si no puede, el importe y el precio.
- **Sin calcular solo**: escribes los valores tal cual vienen en el justificante. Si no cuadran, la línea se marca con el valor correcto y un botón para corregirlo, y no se puede guardar.
- El margen de redondeo por línea es de 0,02 € y se puede cambiar en Ajustes. El servidor vuelve a validar al guardar.
- Cada movimiento conserva los valores importados y su historial. Se puede volver a ellos, y eliminar es reversible.

## Estructura

```
shared/           Tipos, decimales y lógica de cuadre (la usan servidor y cliente)
server/engine/    Motor FIFO, regla de recompra, divisas e informe por casillas
server/importers/ DEGIRO, Trade Republic, Kraken, Revolut y Coinbase
server/           API local, SQLite, tipos del BCE y exportación a Excel
client/           Interfaz en React
tests/            Pruebas del motor, importadores y flujo completo
```

## Copia de seguridad

Guarda `data/fifo.db`: contiene todas las operaciones y su historial. Está excluido de git para que tus datos no acaben en un repositorio.
