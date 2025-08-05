import 'dotenv/config';
import express from 'express';
import puppeteer from 'puppeteer';
import cors from 'cors';
import { createClient } from '@supabase/supabase-js';

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

        // Launch browser
        browser = await puppeteer.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });
        const page = await browser.newPage();

        // Optimize page
        await page.setViewport({ width: 1200, height: 800 });

        // Construct print URL
        const printUrl = new URL('https://lavvel.sanflavva.com/print-labels');
        printUrl.searchParams.set('templateType', templateType);
        printUrl.searchParams.set('dimensions', JSON.stringify(dimensions));
        printUrl.searchParams.set('labels', JSON.stringify(labels));
        printUrl.searchParams.set('barcodeSource', barcodeSource);

        console.log('Navigating to print route...');
        await page.goto(printUrl.toString(), {
            waitUntil: 'networkidle0',
            timeout: 60000
        });

        // Wait for dynamic content
        const waitTime = Math.min(2000 + (labels.length * 100), 10000);
        await new Promise(resolve => setTimeout(resolve, waitTime));

        // Convert dimensions
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

        console.log('Generating PDF...');
        const pdf = await page.pdf({
            width: pdfWidth,
            height: pdfHeight,
            margin: { top: '0px', right: '0px', bottom: '0px', left: '0px' },
            printBackground: true,
            preferCSSPageSize: false
        });

        console.log(`PDF generated successfully: ${pdf.length} bytes for ${labels.length} labels`);

        // Update Supabase record with success
        await supabase
            .from('label_generations')
            .update({
                status: 'completed',
                processed_at: new Date().toISOString(),
                pdf_size: pdf.length
            })
            .eq('id', generationId);

        // Send PDF response
        res.set({
            'Content-Type': 'application/pdf',
            'Content-Disposition': `attachment; filename="labels_${new Date().toISOString().slice(0, 10)}.pdf"`,
            'Content-Length': pdf.length
        });
        res.send(pdf);

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
