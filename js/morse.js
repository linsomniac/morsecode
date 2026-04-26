window.MT = window.MT || {};

MT.MORSE = {
  A: ".-",    B: "-...",  C: "-.-.",  D: "-..",   E: ".",
  F: "..-.",  G: "--.",   H: "....",  I: "..",    J: ".---",
  K: "-.-",   L: ".-..",  M: "--",    N: "-.",    O: "---",
  P: ".--.",  Q: "--.-",  R: ".-.",   S: "...",   T: "-",
  U: "..-",   V: "...-",  W: ".--",   X: "-..-",  Y: "-.--",
  Z: "--..",
  "0": "-----", "1": ".----", "2": "..---", "3": "...--", "4": "....-",
  "5": ".....", "6": "-....", "7": "--...", "8": "---..", "9": "----.",
  ".": ".-.-.-", ",": "--..--", "?": "..--..", "=": "-...-", "/": "-..-.",
};

// Standard Koch teaching order, extended to include digits and a few prosigns.
// = is the BT prosign (break), / is the fraction bar / "AR is .-.-." (handled separately if needed)
MT.KOCH_ORDER = [
  "K","M","U","R","E","S","N","A","P","T","L","W","I",".","J","Z","=",
  "F","O","Y",",","V","G","5","/","Q","9","2","H","3","8","B","?","4",
  "7","C","1","D","6","0","X"
];

MT.charToMorse = function (ch) {
  return MT.MORSE[String(ch).toUpperCase()] || null;
};

// Display label for prosigns / punctuation that look ambiguous in big type
MT.displayLabel = function (ch) {
  if (ch === "=") return "= (BT)";
  if (ch === "/") return "/ (AR)";
  return ch;
};

// Render a morse string ("...-") with bullet/minus glyphs and spacing for display.
MT.formatMorseVisual = function (s) {
  return String(s || "")
    .split("")
    .map((c) => (c === "." ? "·" : c === "-" ? "−" : c))
    .join("  ");
};
