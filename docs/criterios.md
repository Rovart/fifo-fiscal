# Criterios fiscales aplicados

Normativa y numeración de casillas revisadas el 2 de noviembre de 2026 para el ejercicio 2025. Las casillas salen del [anexo del modelo 100 de 2025](https://www.hacienda.gob.es/sgt/normativadoctrina/proyectos/26012026-anexo-i-y-ii-renta-2025.pdf) publicado como proyecto: compruébalas en la campaña que presentes.

## FIFO

- Se aplica por activo y **de forma global entre brókers**: mismo ISIN o misma criptomoneda (art. 37.2 LIRPF; [Manual Renta 2025](https://sede.agenciatributaria.gob.es/static_files/Sede/Biblioteca/Manual/Practicos/IRPF/IRPF-2025/ManualRenta2025Parte1_es_es.pdf), cap. 11).
- **Nombre**: cada ISIN se muestra con el primer nombre importado, porque cada bróker lo llama a su manera. Si otro bróker usa uno muy distinto, Cartera lo indica. Cambiarlo en un movimiento lo cambia en todos.
- Coste: importe más gastos y tributos inherentes (comisión, AutoFX, ITF, TTF). Transmisión: importe menos gastos (art. 35).
- Las fechas se imputan en hora de España. Kraken y Trade Republic exportan en UTC y se convierten.
- Las transferencias entre monederos propios no generan ventas ni consumen lotes. La comisión de esa retirada se registra como gasto no deducible y reduce las unidades sin generar una ganancia o pérdida fiscal. Se distingue de los gastos inherentes a una compraventa o permuta, que ajustan su valor de adquisición o transmisión ([DGT V0648-24](https://petete.tributos.hacienda.gob.es/consultas/?num_consulta=V0648-24), [texto reproducido](https://bm.consulting/es/consultas-vinculantes/V0648-24/)).
- Si hay compras y ventas a la misma hora exacta, se ordenan primero las compras.

## Regla de recompra (art. 33.5.f y g)

Sigue el procedimiento del Manual de Renta 2025:

- Bloquean las compras de los 2 meses anteriores que sigan en cartera tras la venta y las de los 2 meses posteriores. El plazo es de 1 año para valores no admitidos en mercados de la Directiva 2014/65/UE.
- No se limita por compras previas si solo hubo una compra en el periodo y no se tenían títulos al inicio. Esta excepción no ampara una compra posterior.
- La pérdida bloqueada se integra a medida que se transmiten de forma definitiva los valores recomprados. Si esa venta no es definitiva, la pérdida pasa a la nueva compra.
- La pérdida se evalúa por cada lote FIFO consumido.

**Decisión propia**: dentro de un lote parcialmente bloqueado, los primeros títulos que se venden son los que liberan la pérdida. El Manual no detalla este caso.

**Criterio sin cerrar: acciones de EE. UU.** La V0515-16 aplicaba 1 año. Fuentes secundarias citan las V0778-25 y V0951-25 a favor de 2 meses, pero no se ha podido leer su contestación. Por defecto se usan 2 meses y «Revisar» informa de las pérdidas a las que afectaría el plazo de 1 año. Se cambia en Ajustes, en general o por activo.

**ETF y fondos europeos.** Lo que decide el plazo es la admisión en un mercado regulado de la UE, no el domicilio del fondo, que sea UCITS ni en qué invierte. Hay ETF irlandeses cuya clase de acumulación solo cotiza en Londres, que dejó de contar tras el Brexit, y en sistemas multilaterales de la UE (Freiverkehr, gettex), mientras la clase de distribución del mismo fondo sí está en Xetra. Se comprueba por ISIN en [FIRDS (ESMA)](https://registers.esma.europa.eu/publication/searchRegister?core=esma_registers_firds), con la categoría de cada sede en [ISO 10383](https://www.iso20022.org/market-identifier-codes): `RMKT` es mercado regulado y `MLTF`, sistema multilateral. La aplicación toma el mercado de la bolsa de referencia de DEGIRO y no consulta este registro. Lo que elijas en Ajustes, por activo, manda sobre esto y una nueva importación no lo cambia.

**Criptomonedas**: no se aplica el plazo de 2 meses, porque no son valores negociados según la DGT ([análisis de PwC](https://periscopiofiscalylegal.pwc.es/wp-content/uploads/2022/02/La-Agencia-Tributaria-y-la-fiscalidad-de-las-criptomonedas-1.pdf)). Parte de la doctrina plantea el art. 33.5.e para recompras en el año siguiente: se muestra como aviso informativo y no se aplica.

## Divisas

- Se usa el tipo real de la operación si el bróker lo da. Si no, el oficial del BCE de esa fecha o el último publicado (art. 36 Ley 46/1998). En Ajustes se puede forzar el del BCE en todas las operaciones.
- **Dos métodos para valores en divisa**, con el mismo total cuando la conversión es inmediata (AutoFX):
  - *Euros a cada fecha* (por defecto): coste al cambio de la compra y transmisión al de la venta, en una sola línea. Es lo habitual en los informes de brókers y lo que hace el Manual con las criptomonedas.
  - *Separar efecto divisa*: resultado en la divisa del valor al cambio de la venta, con el efecto divisa en otra línea, según las V0282-22 y V0152-26 ([resumen](https://www.iberley.es/noticias/la-dgt-senala-como-cuantificar-ganancia-caso-compraventa-acciones-dolares-conversion-euros-36521)). Esas consultas se han contrastado por resúmenes, no por su texto. **Limitación**: una compra pagada desde un saldo en divisa cuenta como salida de esa divisa, mientras que la DGT la difiere hasta la venta. El total acumulado coincide, pero puede cambiar el ejercicio de imputación.
- Los saldos en divisa llevan su propio FIFO: un dividendo en USD crea un lote y su conversión posterior da resultado (V0463-21 y V1613-25, por resumen). Se declaran en la casilla 1626, clave 4. Un gasto que ninguna entrada llega a cubrir queda sin resultado y con aviso.

## Criptomonedas

| Operación | Tratamiento | Casilla |
|---|---|---|
| Venta por dinero | Ganancia o pérdida del ahorro | 1804, 1806. Clave F en 1803 |
| Permuta | Mayor valor de mercado de lo entregado o lo recibido, que es también el coste de lo recibido (art. 37.1.h) | 1804, 1806. Clave N en 1803 |
| Staking | Capital mobiliario. Crea lote a valor de mercado | 0027 |
| Airdrop | Ganancia sin transmisión, base general | 0304 |

Las claves F y N vienen de [Taxdown](https://taxdown.es/casilla-renta/casilla-1800-de-la-renta-todo-lo-que-debes-saber), no del anexo oficial. Staking y airdrop vienen del [Informador de Renta 2025](https://www2.agenciatributaria.gob.es/wlpl/AVAC-CALC/InformadorRenta2025?id=9.2.2).

Una sentencia del TSJ del País Vasco de 9 de enero de 2025 [rechaza el FIFO en cripto](https://www.cuatrecasas.com/es/global/fiscalidad/art/criptomonedas-metodo-fifo-hacienda-foral). Se mantiene el FIFO porque es el criterio de la DGT y del Manual.

## Casillas de bolsa y capital

| Concepto | Casillas |
|---|---|
| Acciones cotizadas | 0327 denominación, 0328 transmisión, 0331 adquisición, 0332 ganancia, 0337 pérdida obtenida, 0338 pérdida computable |
| ETF e IIC del art. 75.3.j | 2226, 2227, 2229, 2230, 2233, 2234 |
| Intereses | 0027 |
| Dividendos | 0029 |
| Renta fija y otros activos financieros | 0031 |
| Gastos de administración y depósito | 0037 |
| Retenciones españolas | 0597 |
| Doble imposición internacional | 0588 |

- Todos los ETF van al bloque 2224-2236. En algún foro se indica que los cotizados en España irían en 0326-0332; si tienes alguno, compruébalo.
- La pérdida no imputable por recompra se presenta como entrada aparte, con pérdida computable cero.
- **Comisión de conectividad de DEGIRO**: queda como no deducible por prudencia, porque el art. 26 solo admite administración y depósito. Se puede cambiar por operación.
- **ETC**: se avisa porque hay doctrina que los lleva a la casilla 0031 (V0267-25, por resumen). Se cambia en Ajustes, en «Mis activos», con el tipo «Renta fija / ETC».
- **Doble imposición** (art. 80): por país, el menor de lo retenido y el tipo de convenio (15 % por defecto, editable). El total se limita al tipo medio del ahorro aplicado a esas rentas. El exceso se reclama en origen.
- **Devolución de capital**: minora el coste y el exceso es capital mobiliario. Se marca para revisar porque si procede de beneficios no distribuidos es dividendo.

## Particularidades de DEGIRO

- **Comisión AutoFX y costes** se suman como gasto de la operación.
- **Orden de divisa (`EUR/USD`)**: es un cambio de moneda, no una compra de acciones. La fila contraria de la misma orden y la «Liquidación transacción de divisa» son solo su liquidación y no cuentan.
- **Saldo por moneda**: se lleva el saldo real de cada moneda con su propio FIFO. Las compras y ventas en dólares mueven dólares, y los cambios a euros de `Account`, de orden o automáticos, los convierten. Si gastas una moneda antes de tenerla, algo habitual con AutoFX, queda pendiente hasta el cambio que la paga. El cambio ligado a una orden se valora al tipo de esa orden, porque la comisión AutoFX que incluye ya va en la operación: no hay resultado y no aparece en informes. Si vendes en dólares y recompras con ellos sin pasar por euros, sí aflora la diferencia de cambio, que tributa.
- **Sin `Account`** no hay datos de cambio de moneda, así que las operaciones se tratan como pagadas en euros.
- **Comisiones en dólares de una orden de divisa**: se suman a la comisión en euros y no restan de la cuenta en dólares, por lo que el saldo calculado puede diferir unos dólares del real.
- **Split con cambio de ISIN**: se trata como canje neutro. Lo cobrado en efectivo por las fracciones queda en la nota del movimiento y no se calcula como venta, por ser un importe mínimo.
- **Ingresos por préstamo de valores**: rendimiento por cesión de capitales (DA 18.ª Ley 62/2003). Se declaran con los intereses, en la casilla 0027.
- **Interés por saldo negativo**: no es deducible (art. 26 LIRPF), así que no resta de los intereses cobrados.

## Compensación y cuota

- Art. 49: transmisiones y capital mobiliario se compensan entre sí con un máximo del 25 % del saldo positivo. El resto se arrastra cuatro años, primero dentro de su grupo. Las pérdidas de ejercicios anteriores a tus datos se añaden en Ajustes.
- Si indicas tu última Renta presentada en Ajustes, los años anteriores no se recalculan para compensar y solo cuentan las pérdidas pendientes que escribas. Sin indicarla, se simula desde el primer año con datos.
- Escala del ahorro desde 2025: 19, 21, 23, 27 y 30 %. Navarra y País Vasco tienen la suya y no se calcula.
- La cuota es una estimación de estas rentas, no de tu declaración completa.

## Particularidades de Trade Republic

- **Dividendos**: `amount` es el bruto en euros y `tax` junta la retención extranjera con el 19 % español sobre el neto. Cuando `tax` llega al 19 % se separan: `fuera = (tax − 0,19 × bruto) ÷ 0,81`. Por debajo del 19 % todo se considera extranjero. Trade Republic no documenta la columna: la fórmula sale de los datos reales y da exactamente el 15 % de convenio en los dividendos de EE. UU. probados. Se puede corregir en cada movimiento, en «Retenido en España».
- **Intereses**: un `tax` del 19 % es retención española (0597). Otro porcentaje se marca para revisar.
- **Impuesto en una compra**: es un tributo de la operación, como el ITF español del 0,2 %, y suma al coste (art. 35 LIRPF). En una venta se marca para revisar.
- **OPV (`IPO_SUBSCRIPTION`)**: el prepago y la devolución solo mueven efectivo. La comisión se suma a la compra adjudicada o, si no hubo adjudicación, queda como gasto no deducible.

## Particularidades de Kraken

- **Valores**: el ledger da el importe en dólares de cada línea. Las permutas, el staking, los bonos y las comisiones en cripto se valoran con ese dato al cambio del BCE de ese día. Las compras y ventas en otra moneda, como AUD, usan lo pagado en esa moneda al cambio del BCE.
- **`settled`**: entrega del activo al cerrar una posición con margen. Cuenta como compra o venta.
- **`margin` y `rollover`**: las comisiones en cripto se agrupan por mes y reducen el saldo sin contar como venta. Su valor queda como gasto no deducible. Los resultados en euros **no se incluyen**: se avisa por año del importe y, si procede, se añaden a mano.
- **Movimientos internos**: `allocation`, `autoallocation` y similares no son ingresos. En `earn`, solo `reward` lo es.
- **Retiradas**: Kraken solo sabe que el activo salió. Se sigue contando como tuyo («Fuera de los brókers») con su lote y su coste. Si lo vendiste o lo cambiaste fuera, hay que añadirlo a mano.
- **Depósitos**: primero se entiende que vuelve lo que habías sacado. Lo que exceda se considera llegado de fuera, sin coste conocido.

## Particularidades de Revolut

- **Sin ISIN.** El extracto de acciones identifica por símbolo y el FIFO va por ISIN. Se une solo si esa pareja ya se conoce; si no, se avisa una vez por valor y se indica en Ajustes, en Mis activos. Hasta entonces, sus movimientos forman un FIFO aparte.
- **Dividendos.** El extracto da el importe ya neto. Se marca para revisar el bruto y la retención con el informe anual.
- **Comisión.** No viene separada: es la diferencia entre el total y cantidad por precio.
- **Tipo de cambio.** El de la fila solo se usa si encaja con el BCE, directo o invertido, porque no consta en qué sentido lo da. Si no, se usa el BCE.
- **Dólares.** Los ingresos en dólares crean saldo en esa moneda y las compras lo consumen, igual que en DEGIRO.
- **Gastos.** La custodia es deducible (art. 26 LIRPF). La gestión de carteras (Robo), no.
- **Cripto.** Las recompensas de aprendizaje van como airdrop (0304) y las de staking, a 0027.

## Particularidades de Coinbase

- **Hora.** Exporta en UTC y se convierte.
- **Permutas.** `Convert` y las compras o ventas pagadas con otra cripto, como SOL-USDC, son permutas valoradas con el importe del informe.
- **Rendimientos.** `Rewards Income` y `Staking Income` van a 0027. `Coinbase Earn` y `Learning Reward`, como airdrop (0304).
- **Pagos con cripto.** `Card Spend`, `Donation` y similares cuentan como venta y se marcan para revisar.
- **Internos.** Los traspasos a Pro, a Exchange o a staking no tienen efecto.

## Desempeño

Responde a «cuánto he ganado de verdad», antes de impuestos, y no sigue las reglas fiscales:

```
Resultado del año = lo vendido + dividendos e intereses − gastos + cambio en lo no vendido
```

- **Lo vendido** incluye las pérdidas aplazadas, porque ya ocurrieron. Por eso no coincide con lo que tributa.
- **Cambio en lo no vendido**: valor menos coste a cierre del año, menos lo mismo a cierre del anterior.
- **Sin coste conocido**: lo vendido sin compra no cuenta como ganancia, y se indica cuánto es.
- **Sin precio**: el activo cuenta a su coste, sin ganar ni perder, y se avisa.
- **Precios**: cierres mensuales de Yahoo, deshaciendo sus ajustes por splits, pasados a euros al cambio del BCE de fin de mes. El año en curso usa la cotización de hoy.
- **Rentabilidad**: Dietz modificado, el resultado sobre el valor inicial más lo aportado según el tiempo que estuvo invertido. Si por muchas compras y ventas ese capital baja de un 25 % de la media invertida, se usa la media. El total encadena los años.

Comprobado contra el método directo (valor final − inicial − aportado + rentas − gastos): coincide al céntimo, salvo el staking, que entra como valor y como renta, y los gastos de margen pagados en cripto.

## Avisos por ejercicio

«Revisar» muestra los avisos del año elegido y los de años anteriores solo si afectan a un activo que se vende ese año. Una venta antigua sin compras de un activo que no se vuelve a tocar no cambia el FIFO de los años siguientes.

Tampoco se arrastra si lo vendido llegó de fuera por un depósito y ya se vendió entero: esas unidades son las más antiguas y, una vez consumidas, los lotes restantes son los mismos que si constara su coste. El aviso sigue en el año de la venta, porque ahí sí falta el coste.

## Precios actuales

Cartera y «¿Y si vendo?» usan precios de Yahoo Finance mediante la librería `yahoo-finance2`, solo cuando se pide. El símbolo se busca por ISIN, dando preferencia a la bolsa del país del ISIN; si Yahoo no lo conoce, por nombre. El símbolo usado se ve al desplegar cada valor. Las criptomonedas que Yahoo no tiene usan el último precio de Kraken. Son orientativos, no valores fiscales, y no incluyen comisiones de venta.

## Modelos 720 y 721

Se muestra la posición a 31 de diciembre con su coste y un aviso si supera 50.000 €. El umbral real va por valor de mercado, que la aplicación no conoce para acciones: compruébalo aparte.

## Límites conocidos

- **Importadores.** Salvo lo indicado, se han hecho con formatos públicos y ficheros de prueba:
  - DEGIRO: probado con una exportación real en español. Otros idiomas o formatos se basan en ejemplos públicos. Los conceptos de `Account` se reconocen por texto y lo que no reconoce se avisa.
  - Trade Republic: probado con una exportación real. El significado de las columnas de impuestos se ha deducido de los datos.
  - Kraken: probado con un ledger real con columnas en dólares. Sus saldos calculados coinciden con los del fichero.
  - Coinbase y cripto de Revolut: columnas tomadas del proyecto abierto [BittyTax](https://github.com/BittyTax/BittyTax), sin un fichero real.
  - Acciones de Revolut: columnas de memoria, sin confirmar en ninguna fuente pública ni con un fichero real. Si cambian, el fichero se rechaza con un aviso.
- **No se calcula sola**: resultados de margen en euros, futuros, derivados, escisiones y canjes con efectivo. Se avisa y se añaden a mano.
- **Saveback y similares de Trade Republic**: sin criterio específico. Se tratan como recompensa (0304) y se marcan para revisar.
- **Operaciones a corto**: no contempladas. Se muestran como ventas sin compra.
- **Fondos no cotizados y traspasos**: no contemplados, porque estos brókers no los ofrecen como tales.
