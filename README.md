# FIFO Fiscal

Calcula el FIFO y prepara el IRPF de bolsa y criptomonedas según los criterios de la AEAT y la DGT, con DEGIRO, Trade Republic, Kraken, Revolut, Coinbase y CoinTracking. Funciona solo en tu equipo: los datos se guardan en `data/fifo.db` y el servidor únicamente acepta conexiones locales. Consulta automáticamente tipos del BCE, cotizaciones e históricos públicos, identificadores y repartos publicados para completar las importaciones. A los proveedores solo se envían identificadores y símbolos públicos, nunca nombres de personas, documentos, cantidades ni importes de la cartera.

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

En Linux, ejecuta `./linux/install-shortcut` una vez para añadir **FIFO Fiscal** al escritorio y al menú. El acceso directo arranca el servidor si hace falta y abre el navegador; volver a pulsarlo reutiliza el servidor. Los registros de arranque quedan en `data/server.log`.

Cada persona tiene sus propios datos: se guardan en `data/`, que git ignora, y nunca se suben al repositorio. No dejes extractos ni tu base de datos fuera de esa carpeta si vas a contribuir con cambios. Para actualizar, `git pull` y `npm install`; tus datos se conservan.

Al empezar, en **Ajustes**, indica tu última renta presentada: lo anterior no se vuelve a calcular.

## Cómo se usa

La barra lateral sigue tres pasos:

1. **Documentos**: arrastra uno o varios CSV. El bróker y el formato se detectan solos. La primera vez, incluye el historial de tus compras. Después verás desde qué fecha hacen falta movimientos para continuar el FIFO: el cálculo conserva los antecedentes de posiciones abiertas, canjes, divisas y pérdidas aplazadas y comprueba el resultado al recalcular desde esa fecha. Para declarar un ejercicio se necesitan también sus movimientos y las pérdidas pendientes de compensar. Los archivos se agrupan por exchange: puedes añadir más, quitar uno o retirar todos los de un exchange.
   - DEGIRO: `Transactions` y `Account`.
   - Trade Republic: «Exportación de transacciones».
   - Kraken: `Ledgers`, no `Trades`.
   - Revolut: el extracto de cuenta de Inversiones y el de Cripto. Los CSV antiguos solo dan ticker. Se identifica el ISIN automáticamente cuando hay una correspondencia inequívoca, se aprovecha la columna ISIN si existe y se resuelve la bolsa de los ETF europeos. Un ADR mantiene su propio ISIN.
   - Coinbase: «Transaction history», desde el principio.
   - CoinTracking: la lista de operaciones (Introducir monedas → Exportar → CSV), no el informe fiscal. Las filas de Kraken o Coinbase que ya cubren sus propios extractos se omiten, así que conviene añadir esos extractos antes. Las permutas entre criptos se valoran a 1 USD si una parte es una stablecoin en dólares y, si no, con el precio de Kraken del activo entregado o del recibido; la valoración se hace sola en segundo plano. Lo que trae CoinTracking cuenta como una cartera externa: un depósito posterior en Kraken o Coinbase sale primero de ahí.
2. **Revisar**: completa automáticamente los datos contrastables y muestra lo que aún necesita información. Los dividendos netos pueden conciliarse con el reparto publicado y la cantidad con derecho en la fecha exdividendo. El bruto se reconstruye con esos datos y la retención por diferencia, conservando el neto importado. Se exige coincidencia de fecha, divisa e importe (un céntimo, más la diferencia comprobable entre 4 y 6 decimales por acción, con límite total de cinco céntimos). No se aplica un porcentaje supuesto al neto. Los importes reconstruidos y sus fuentes aparecen en el movimiento; un justificante del bróker permite corregirlos si su redondeo difiere. Las ediciones manuales se respetan. Los avisos de ingresos antiguos no se arrastran a otro ejercicio por vender después el mismo activo.
3. **Mi Renta**: copia cada importe a su casilla con un clic y marca lo que ya has pasado a Renta Web. También exporta a Excel o PDF.
   - **Dossier**: un documento del ejercicio para revisarlo con un gestor. Incluye las casillas, cada venta con las compras que consume, las rentas por activo, las pérdidas aplazadas y los criterios y ajustes aplicados (coste 0, regla de 2017, restos cerrados, correcciones a mano). Se imprime o se guarda en PDF desde el navegador.
   - **Modelos 720 y 721**: valoran lo que tenías en brókers y exchanges extranjeros a 31 de diciembre, con el cierre de diciembre de cada activo (el año en curso, con el precio de hoy). La primera vez avisa si pasa de 50.000 €. Si anotas un modelo como presentado, en los años siguientes avisa cuando sube más de 20.000 € o cierras algo que declaraste. Las criptomonedas retiradas a una cartera se muestran aparte. Las cuentas de efectivo no entran en el cálculo.

En **Inicio**, durante el año en curso, se ve hasta cuándo llegan los datos de cada bróker y se avisa si pasa más de un mes sin subir un extracto de uno en el que aún tienes algo. Del 1 de octubre al 31 de diciembre aparece además lo que podrías compensar antes de fin de año: tus pérdidas sin vender, cuánto bajaría la cuota y cuáles se aplazarían por haber comprado hace poco.

Para consultar: **Movimientos** (el extracto completo, donde se edita y se añade), **Cartera** (qué tienes, cuánto vale hoy con precios de Yahoo y en qué orden se venderá; los saldos a cero se ocultan salvo que actives el interruptor), **Resultados** (ventas, dividendos e intereses), **Desempeño** (lo ganado o perdido de verdad cada año, con gráficas) y **¿Y si vendo?** (una barra por cada activo para ver al momento lo que pagarías, sin guardar nada).

Reimportar un fichero es seguro: lo repetido se ignora y tus ediciones se conservan. Si quitas un documento, sus movimientos duplicados siguen disponibles mientras aparezcan en otro documento que conserves.

El selector de cuenta de la barra lateral permite crear una cuenta para cada persona y cambiar entre ellas. Cada cuenta tiene documentos, movimientos, ajustes, FIFO y marcas de Renta independientes. Los datos existentes quedan en **Mi cuenta**.

En **Ajustes → Recalcular FIFO**, un botón comprueba automáticamente desde dónde empieza el FIFO actual. Verifica las cantidades, la ubicación y el coste actuales, las pérdidas aplazadas y los resultados de todos los ejercicios sin presentar. Usa la «Última Renta presentada» para delimitar los ejercicios pendientes. Después de activarlo, vuelve a comprobar el inicio al importar o editar movimientos.

Los movimientos de ciclos anteriores siguen visibles en Movimientos, Resultados, Desempeño, Mi Renta y las exportaciones. El botón no los elimina ni los excluye de sus ejercicios: solo identifica qué antecedentes necesita el FIFO actual. Los movimientos antiguos se marcan como «Ciclo anterior». Los saldos en divisa mantienen sus antecedentes. Una retirada a una cartera externa sigue siendo propiedad del titular: que un exchange llegue a cero no prueba por sí solo que se haya vendido todo. Si faltan retornos o costes, conserva el historial necesario sin inventarlos.

Un resto mínimo tras el último movimiento de un activo (como mucho el 0,1 % de lo que movió y con un coste inferior a 1 €, por ejemplo fracciones de acción o restos de un exchange) se cierra solo, sin efecto fiscal, para que no quede como saldo.

Si el titular confirma un saldo total cero en un mes ya declarado, se puede registrar esa confirmación como dato de inventario (`fifoConfirmedClosures`, con mes y motivo, por activo o con `CRYPTO:*` para todas las criptomonedas). Para reproducir un informe antiguo de CoinTracking, `shortfallCover` (`from`, `to`) hace que las ventas de cripto de ese periodo hechas antes de su compra tomen el coste de las compras siguientes; fuera de él cuentan con coste 0 y aviso. El inventario se pone a cero al cierre de ese mes, sin crear una venta, alterar las ganancias anteriores ni ocultar sus movimientos. El recálculo deduce el siguiente ciclo a partir de las operaciones posteriores. La confirmación debe referirse también a las carteras externas y no puede eliminar resultados de años sin presentar.

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
server/importers/ DEGIRO, Trade Republic, Kraken, Revolut, Coinbase y CoinTracking
server/           API local, SQLite, tipos del BCE, exportación a Excel, dossier, 720/721 y copias
client/           Interfaz en React
tests/            Pruebas del motor, importadores y flujo completo
```

## Copia de seguridad

Cada día que la aplicación está abierta guarda una copia comprimida de todas las cuentas en `data/backups/auto/` (o en `FIFO_BACKUP_DIR`). Conserva una por día de la última semana con copia, una por mes del último año y, durante un mes, las que hagas a mano y las de antes de restaurar. Las copias que dejes tú en `data/backups/` no se tocan. Desde **Ajustes → Copias de seguridad** puedes hacer una al momento o devolver la cuenta actual a como estaba en una copia; antes se guarda cómo está ahora y las demás cuentas no cambian.

Para protegerte de una avería del disco, guarda también la carpeta `data/` completa en otro sitio. La cuenta original está en `data/fifo.db` y las adicionales en `data/profiles/`. Incluye las operaciones y su historial de todas las personas y está excluida de git. Haz esa copia con la aplicación cerrada.
