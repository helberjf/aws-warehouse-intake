# Synthetic test data

The optional demo dataset adds 16 warehouse records, eight products and 48 receiving movements to the local `DEMO` organization. These are synthetic records for exercising the browser and barcode workflow. Product barcodes have valid EAN-13 check digits but are not GS1 assignments and must not be used as labels for real commercial goods.

## Load the examples

Start the normal local stack first, then seed the extra data:

```powershell
npm run local:configure
docker compose up -d --build
npm run demo:seed
```

The script requires `ENVIRONMENT=local` and a localhost/LocalStack emulator endpoint. It checks that the application table already exists and creates no AWS resources. The API publisher and worker must be running to move accepted receipts into stock. It does not directly set stock quantities or bypass the normal acceptance transaction.

The resulting private files are:

- `.tokens/demo-logins.json`: generated credentials and account metadata.
- `.tokens/dados-de-teste.txt`: Portuguese sign-in instructions for the person testing the interface.

Both are ignored by Git. Passwords are randomly generated and are not printed to the terminal. An existing test account is preserved without resetting its password, permissions or sessions. When a saved password no longer matches an existing account, the report identifies that condition without resetting anything; use an explicit administrator recovery procedure. The pre-existing local `admin` account is not modified.

## Test accounts

| Username         | Role                        | Warehouses          | Intended test                                                                                      |
| ---------------- | --------------------------- | ------------------- | -------------------------------------------------------------------------------------------------- |
| `gestor.teste`   | Administrator and receiving | All 16 listed below | Register/edit products, receive goods and inspect all demo warehouses                              |
| `operador.teste` | Receiving                   | WH-01 and WH-02     | Receive and inspect permitted stock; verify product administration and other warehouses are denied |

Both belong to organization `DEMO`. Read their generated passwords from the ignored local instructions file. The browser shows the currently signed-in user's display name. Products and movements created by the seed itself truthfully identify **Carga de demonstração**; records subsequently registered through the interface identify the actual signed-in account.

## Warehouse directory

| ID    | Location       |
| ----- | -------------- |
| WH-01 | São Paulo      |
| WH-02 | Campinas       |
| WH-03 | Rio de Janeiro |
| WH-04 | Belo Horizonte |
| WH-05 | Curitiba       |
| WH-06 | Porto Alegre   |
| WH-07 | Florianópolis  |
| WH-08 | Brasília       |
| WH-09 | Goiânia        |
| WH-10 | Salvador       |
| WH-11 | Recife         |
| WH-12 | Fortaleza      |
| WH-13 | Belém          |
| WH-14 | Manaus         |
| WH-15 | Cuiabá         |
| WH-16 | Vitória        |

Existing warehouse records are preserved if they already use one of these IDs. Only the new test manager account automatically receives grants for all 16 warehouses; the original local administrator retains its previous grants.

## Products and printable labels

Open `http://localhost:3000/demo-barcodes.html` on a second display or print it using the browser. The page contains inline SVG barcode patterns and has no external assets or executable scripts. The camera scanner can read these labels, or a keyboard-emulating USB/Bluetooth scanner can enter their values.

| SKU              | Product                 | Barcode       | Tracking   |
| ---------------- | ----------------------- | ------------- | ---------- |
| DEMO-CAIXA       | Storage box 40 L        | 7899000000010 | Bulk       |
| DEMO-CADERNO     | A5 ruled notebook       | 7899000000027 | Bulk       |
| DEMO-GARRAFA     | Insulated bottle 750 ml | 7899000000034 | Bulk       |
| DEMO-CABO        | USB-C cable 1 m         | 7899000000041 | Bulk       |
| DEMO-FERRAMENTAS | Twelve-piece tool set   | 7899000000058 | Bulk       |
| DEMO-ENVELOPE    | Padded envelope         | 7899000000065 | Bulk       |
| DEMO-FONE        | Bluetooth headphones    | 7899000000072 | Serialized |
| DEMO-COLETOR     | Handheld data terminal  | 7899000000089 | Serialized |

The full catalog is [demo-products.json](../examples/demo-products.json). These SKUs are separate from the original `BULK-001` and `SERIAL-001` smoke-test products. The seed does not rename or reset those original products.

## Expected receiving results

Each warehouse receives three stable movements:

1. Ten units of a bulk product.
2. Five units of a different bulk product.
3. One serialized product with a unique synthetic serial number.

This produces **16 synthetic units per warehouse, 256 units across 48 movements**, once processing finishes. Bulk SKUs rotate across the warehouses; serialized SKUs alternate between headphones and handheld terminals. The exact body, warehouse, stable HTTP key and business reference for every movement appear in [demo-receiving.json](../examples/demo-receiving.json).

All references begin with `demo-v1-`, use the stable `demo-seed-v1` producer namespace and retain their original event timestamp. Running `demo:seed` again replays those same receipts; it does not add another 256 units. New manual receipts deliberately increase the balances, so compare the fixture subset rather than assuming the entire warehouse contains only demo stock.

## Suggested checks

- Sign in as the test manager and confirm all 16 warehouses are available.
- Open each warehouse's stock. After processing and index propagation, its seeded subset totals 16 units in three SKU/lot balances.
- Read a printed bulk-product code, confirm its details and receive an additional quantity. Check the status and stock change.
- Read a serialized-product code and enter a new unit serial. A repeated existing serial should become `REJECTED` without another stock increment.
- Register a new product while signed in as the test manager. Verify its creator and creation time, then edit it and confirm the original creator remains unchanged.
- Sign in as the test operator. Confirm WH-01/WH-02 access and denial of product administration or any other warehouse, including a direct API request.
- Run the seed again and confirm fixture receipt IDs and seeded stock effects remain unchanged.

Camera validation still depends on the actual phone, permissions, HTTPS/localhost context, print quality and lighting. Data fixtures and valid check digits are not evidence that a particular physical device has been tested. See [browser operation](browser.md) for scanner and credential details.
