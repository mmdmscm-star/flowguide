"use client";

// The only interactive thing on the print route, and it prints nothing itself.
//
// `.pg-noprint` removes it from the paper, so what a professional sees on
// screen is the document plus one bar, and what comes out of the printer is
// the document alone. Save-as-PDF is the same dialog - the browser offers it as
// a destination - which is why FlowGuide needs no PDF generator to hand someone
// a PDF.
export default function PrintToolbar() {
  return (
    <div className="pg-noprint" style={{
      position: "sticky", top: 0, zIndex: 10, display: "flex", gap: 12,
      alignItems: "center", justifyContent: "center", flexWrap: "wrap",
      padding: "10px 16px", background: "#f0fdf4",
      borderBottom: "1px solid #bbf7d0", textAlign: "center",
    }}>
      <button
        onClick={() => window.print()}
        style={{
          padding: "7px 16px", borderRadius: 8, border: "none", cursor: "pointer",
          background: "#1a56db", color: "#fff", fontSize: 14, fontWeight: 600,
        }}
      >
        Print / Save as PDF
      </button>
      <span style={{ fontSize: 13, color: "#3f6212" }}>
        Choose <b>Save as PDF</b> as the destination to send it as a file.
      </span>
    </div>
  );
}
