import express from 'express';
import puppeteer from 'puppeteer';
import cors from 'cors';



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
        // Check if request body exists and is not empty
        if (!req.body || Object.keys(req.body).length === 0) {
            return res.status(400).json({
                error: 'No data provided. Please send a valid JSON payload with labels, templateType, dimensions, and barcodeSource.'
            });
        }

        const { labels, templateType, dimensions, barcodeSource } = req.body;

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

        // Send PDF response
        res.set({
            'Content-Type': 'application/pdf',
            'Content-Disposition': `attachment; filename="labels_${new Date().toISOString().slice(0, 10)}.pdf"`,
            'Content-Length': pdf.length
        });
        res.send(pdf);

    } catch (error) {
        console.error('PDF generation error:', error);
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
