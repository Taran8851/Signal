//! Text from a document the user adds as their profile (a CV): PDF, .docx, or plain text.
//! Runs off the main thread, and a document that makes the PDF reader panic gives an error
//! instead of closing the app.

use base64::Engine;
use std::io::Read;

const MAX_BYTES: usize = 10 * 1024 * 1024;
const MAX_TEXT: usize = 20_000;

pub async fn extract(name: &str, data_b64: &str) -> Result<String, String> {
    let b64 = data_b64.split_once(',').map(|(_, d)| d).unwrap_or(data_b64);
    let bytes = base64::engine::general_purpose::STANDARD.decode(b64.trim()).map_err(|_| "That file couldn't be read.".to_string())?;
    if bytes.len() > MAX_BYTES {
        return Err("That file is larger than 10 MB.".into());
    }
    let lower = name.to_lowercase();
    let text = tokio::task::spawn_blocking(move || {
        std::panic::catch_unwind(|| {
            if lower.ends_with(".pdf") || bytes.starts_with(b"%PDF") {
                pdf_extract::extract_text_from_mem(&bytes).map_err(|_| "Signal couldn't read the text in that PDF.".to_string())
            } else if lower.ends_with(".docx") {
                docx_text(&bytes)
            } else {
                Ok(String::from_utf8_lossy(&bytes).into_owned())
            }
        })
        .unwrap_or_else(|_| Err("Signal couldn't read that PDF (it may be scanned or damaged). Paste the text instead.".into()))
    })
    .await
    .map_err(|_| "Signal couldn't read that file.".to_string())??;
    let tidy: String = text
        .lines()
        .map(|l| l.split_whitespace().collect::<Vec<_>>().join(" "))
        .filter(|l| !l.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    if tidy.len() < 40 {
        return Err("That file has almost no text Signal can read (a scanned PDF?). Paste the text instead.".into());
    }
    Ok(tidy.chars().take(MAX_TEXT).collect())
}

fn docx_text(bytes: &[u8]) -> Result<String, String> {
    let mut zip = zip::ZipArchive::new(std::io::Cursor::new(bytes)).map_err(|_| "That .docx file couldn't be opened.".to_string())?;
    let mut xml = String::new();
    zip.by_name("word/document.xml")
        .map_err(|_| "That .docx file has no document text.".to_string())?
        .take(MAX_BYTES as u64)
        .read_to_string(&mut xml)
        .map_err(|_| "That .docx file couldn't be read.".to_string())?;
    // Paragraphs and line breaks become new lines; everything else is tags.
    let marked = xml.replace("</w:p>", "\n").replace("<w:br/>", "\n").replace("<w:tab/>", " ");
    Ok(marked.lines().map(crate::page::strip_tags).collect::<Vec<_>>().join("\n"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_text_and_bad_pdf() {
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let b64 = |s: &[u8]| base64::engine::general_purpose::STANDARD.encode(s);
        let cv = "Jane Doe\nSecond-year BSc Computer Science, IIT Delhi, India\nGraduating 2028";
        assert_eq!(rt.block_on(extract("cv.txt", &b64(cv.as_bytes()))).unwrap(), cv);
        // A broken PDF gives an error, not a crash.
        assert!(rt.block_on(extract("cv.pdf", &b64(b"%PDF-1.4 garbage garbage"))).is_err());
    }
}

// Real files made with LibreOffice. Run with: CV_DIR=/path/with/cv.pdf+cv.docx cargo test -- --ignored real_files
#[cfg(test)]
mod real {
    use super::*;

    #[test]
    #[ignore]
    fn real_files() {
        let dir = std::path::PathBuf::from(std::env::var("CV_DIR").expect("CV_DIR"));
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        for name in ["cv.pdf", "cv.docx"] {
            let bytes = std::fs::read(dir.join(name)).unwrap();
            let b64 = base64::engine::general_purpose::STANDARD.encode(&bytes);
            let out = rt.block_on(extract(name, &b64));
            println!("{name}: {out:?}");
            assert!(out.unwrap().contains("IIT Delhi"));
        }
    }
}
