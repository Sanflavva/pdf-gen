import 'dotenv/config';
import express from 'express';
import puppeteer from 'puppeteer';
import cors from 'cors';
import { createClient } from '@supabase/supabase-js';
import { PDFDocument } from 'pdf-lib';

// Initialize Supabase client
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_KEY;

if (!supabaseUrl || !supabaseKey) {
    console.error('Missing Supabase environment variables. Please set SUPABASE_URL and SUPABASE_ANON_KEY');
    process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

const app = express();

// Enable CORS for all routes
app.use(cors());

app.use(express.json());

// Helper function to update progress
const updateProgress = async (generationId, progress, message) => {
    await supabase
        .from('label_generations')
        .update({ 
            progress: progress,
            progress_message: message,
            // updated_at: new Date().toISOString()
        })
        .eq('id', generationId);
    console.log(`Progress ${progress}%: ${message}`);
};

// Health check endpoint
app.get('/health', (req, res) => {
    res.status(200).json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// PDF generation route
app.post('/generate-pdf', async (req, res) => {
    let browser = null;
    try {
        // Check if request body exists and has generationId
        if (!req.body || !req.body.generationId) {
            return res.status(400).json({
                error: 'No generationId provided. Please send a valid JSON payload with generationId.'
            });
        }

        const { generationId } = req.body;

        // Update progress: Starting
        await updateProgress(generationId, 10, 'Fetching generation data...');

        // Fetch data from Supabase
        console.log(`Fetching data for generation ID: ${generationId}`);
        const { data: generationData, error: fetchError } = await supabase
            .from('label_generations')
            .select('*')
            .eq('id', generationId)
            .single();

        if (fetchError) {
            console.error('Supabase fetch error:', fetchError);
            return res.status(500).json({ error: `Failed to fetch generation data: ${fetchError.message}` });
        }

        if (!generationData) {
            return res.status(404).json({ error: 'Generation not found' });
        }

        // Update status to processing
        await supabase
            .from('label_generations')
            .update({ status: 'processing' })
            .eq('id', generationId);

        // Extract data from the fetched record
        const { payload, template_type: templateType, dimensions, barcode_source: barcodeSource } = generationData;
        const labels = payload.labels || payload; // Handle both formats

        // Validation
        if (!labels || !Array.isArray(labels) || labels.length === 0) {
            return res.status(400).json({ error: 'Invalid or missing labels data' });
        }
        if (!templateType) {
            return res.status(400).json({ error: 'Missing template type' });
        }
        if (!dimensions || !dimensions.width || !dimensions.height || !dimensions.unit) {
            return res.status(400).json({ error: 'Invalid dimensions data' });
        }

        console.log(`Processing ${labels.length} labels with template: ${templateType}`);

        // Update progress: Data fetched
        await updateProgress(generationId, 20, 'Launching browser...');

        // Launch browser
        browser = await puppeteer.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });

        await updateProgress(generationId, 30, 'Navigating to print page...');

        const page = await browser.newPage();

        // Optimize page
        await page.setViewport({ width: 1200, height: 800 });

        // Split labels into chunks of 50 if more than 50 labels
        const chunkSize = 50;
        const labelChunks = [];

        if (labels.length > chunkSize) {
            for (let i = 0; i < labels.length; i += chunkSize) {
                labelChunks.push(labels.slice(i, i + chunkSize));
            }
            console.log(`Split ${labels.length} labels into ${labelChunks.length} chunks of max ${chunkSize} labels each`);
        } else {
            labelChunks.push(labels);
            console.log(`Processing all ${labels.length} labels in single chunk`);
        }

        // Convert dimensions for PDF generation
        const convertDimension = (value, unit) => {
            switch (unit.toLowerCase()) {
                case 'in': return `${value}in`;
                case 'mm': return `${value}mm`;
                case 'cm': return `${value}cm`;
                case 'px': return `${value}px`;
                default: return `${value}px`;
            }
        };

        const pdfWidth = convertDimension(dimensions.width, dimensions.unit);
        const pdfHeight = convertDimension(dimensions.height, dimensions.unit);

        // Array to store PDF buffers for merging
        const pdfBuffers = [];
        const progressStep = Math.floor(50 / labelChunks.length); // 50% of progress for processing chunks

        // Process each chunk
        for (let chunkIndex = 0; chunkIndex < labelChunks.length; chunkIndex++) {
            const chunk = labelChunks[chunkIndex];
            const currentProgress = 30 + (chunkIndex * progressStep);

            await updateProgress(generationId, currentProgress, `Processing chunk ${chunkIndex + 1}/${labelChunks.length} (${chunk.length} labels)...`);

            console.log(`Processing chunk ${chunkIndex + 1}/${labelChunks.length} with ${chunk.length} labels`);

            // Construct print URL for this chunk
            const printUrl = new URL('https://lavvel.sanflavva.com/print-labels');
            printUrl.searchParams.set('templateType', templateType);
            printUrl.searchParams.set('dimensions', JSON.stringify(dimensions));
            printUrl.searchParams.set('labels', JSON.stringify(chunk));
            printUrl.searchParams.set('barcodeSource', barcodeSource);

            console.log(`Navigating to print route for chunk ${chunkIndex + 1}...`);
            await page.goto(printUrl.toString(), {
                waitUntil: 'networkidle0',
                timeout: 60000
            });

            // Wait for dynamic content (adjusted for chunk size)
            const waitTime = Math.min(2000 + (chunk.length * 100), 10000);
            await new Promise(resolve => setTimeout(resolve, waitTime));

            // Generate PDF for this chunk
            const chunkPdf = await page.pdf({
                width: pdfWidth,
                height: pdfHeight,
                margin: { top: '0px', right: '0px', bottom: '0px', left: '0px' },
                printBackground: true,
                preferCSSPageSize: false
            });

            pdfBuffers.push(chunkPdf);
            console.log(`Chunk ${chunkIndex + 1} PDF generated: ${chunkPdf.length} bytes`);
        }

        await updateProgress(generationId, 80, 'Merging PDF chunks...');

        // Merge PDFs if multiple chunks, otherwise use single PDF
        let finalPdf;
        if (pdfBuffers.length === 1) {
            finalPdf = pdfBuffers[0];
            console.log('Single chunk PDF, no merging needed');
        } else {
            console.log(`Merging ${pdfBuffers.length} PDF chunks...`);

            // Create a new PDF document for merging
            const mergedPdf = await PDFDocument.create();

            // Add pages from each PDF buffer
            for (let i = 0; i < pdfBuffers.length; i++) {
                const pdfDoc = await PDFDocument.load(pdfBuffers[i]);
                const pages = await mergedPdf.copyPages(pdfDoc, pdfDoc.getPageIndices());
                pages.forEach((page) => mergedPdf.addPage(page));
                console.log(`Merged chunk ${i + 1}/${pdfBuffers.length}`);
            }

            // Serialize the merged PDF
            finalPdf = await mergedPdf.save();
            console.log(`PDF merging completed: ${finalPdf.length} bytes`);
        }

        console.log(`PDF generated successfully: ${finalPdf.length} bytes for ${labels.length} labels`);

        await updateProgress(generationId, 100, 'PDF generated successfully');

        // Update Supabase record with success
        await supabase
            .from('label_generations')
            .update({
                status: 'completed',
                error_message: null,
                processed_at: new Date().toISOString(),
                pdf_size: finalPdf.length
            })
            .eq('id', generationId);

        // Send PDF response
        res.set({
            'Content-Type': 'application/pdf',
            'Content-Disposition': `attachment; filename="labels_${new Date().toISOString().slice(0, 10)}.pdf"`,
            'Content-Length': finalPdf.length
        });
        res.send(finalPdf);

    } catch (error) {
        console.error('PDF generation error:', error);

        // Update Supabase record with error if generationId exists
        if (req.body && req.body.generationId) {
            await supabase
                .from('label_generations')
                .update({
                    status: 'failed',
                    error_message: error.message,
                    processed_at: new Date().toISOString()
                })
                .eq('id', req.body.generationId);
        }

        res.status(500).json({ error: `PDF generation failed: ${error.message}` });
    } finally {
        if (browser) {
            await browser.close();
        }
    }
});

// Start server
const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
