# Contenido del launcher

El launcher lee `contenido.json` (en la raíz de este repo) cada vez que se abre. Para cambiar
noticias, avisos, la dirección del reino o los fondos basta con editar ese fichero aquí en GitHub
(lápiz → *Commit changes*). No hay que compilar ni sacar versión. GitHub tarda unos minutos en
servir la versión nueva. Sin conexión, el launcher usa el último que bajó.

Si el JSON queda mal escrito, el launcher lo ignora y sigue con el último bueno. Antes de guardar
puedes comprobarlo en https://jsonlint.com.

## Campos

| Campo | Qué es |
|---|---|
| `lema` | Frase bajo el título de la portada. |
| `chip` | Etiqueta dorada encima del título. |
| `aviso` | `null` para no enseñar nada, o `{ "texto": "...", "tipo": "info" }`. Con `"tipo": "mantenimiento"` sale en dorado. |
| `reino` | `{ "host": "tu.ip.o.dominio", "puerto": 3724 }`. Es la dirección que usa el launcher para ver si el reino está en línea y la que escribe en el `realmlist` del jugador (salvo que él la cambie en Ajustes). |
| `releases_cliente` | Dónde están las versiones del juego. Normalmente no se toca. |
| `enlaces` | `{ "discord": "https://...", "web": "https://..." }`. Vacío = el botón no sale. Solo se aceptan enlaces `https://`. |
| `fondos` | Lista de fondos que van rotando. Nombres de los que trae el launcher (`kalimdor`, `reinos`, `moltencore`, `blackwinglair`, `ahnqiraj`, `naxxramas`, `zulgurub`, `blackrockspire`, `scholomance`, `deadmines`, `shadowfang`, `diremaul`) o URL `https://` de una imagen. |
| `noticias` | Lista de noticias, la primera es la destacada. Cada una: `titulo`, `categoria` (`Parche`, `Novedad`, `Aviso`, `Servidor`, `Evento`), `fecha` (`AAAA-MM-DD`), `imagen` (nombre de fondo o URL) y `resumen`. |

## Imágenes propias

Sube la imagen a esta carpeta `contenido/` y usa su URL «raw»:

    https://raw.githubusercontent.com/neeme22/azeroth-reborn-launcher/main/contenido/mi-imagen.jpg

Tamaño recomendado: 1600 × 700 px, en JPG.
