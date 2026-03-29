// src/test-db.js
import { query, pool } from './db.js';

async function testDb() {
  try {
    console.log('=== TESTE DB ===\n');

    const conn = await query(`
      SELECT NOW() AS now, current_database() AS db_name
    `);

    console.log('Ligação OK');
    console.log('Database:', conn.rows[0].db_name);
    console.log('Now:', conn.rows[0].now);

    const extensionCheck = await query(`
      SELECT extname
      FROM pg_extension
      WHERE extname = 'pgcrypto'
    `);

    console.log('\npgcrypto instalado:', extensionCheck.rows.length > 0 ? 'SIM' : 'NÃO');

    const tablesCheck = await query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_name IN (
          'app_users',
          'mesas',
          'mesa_qr_tokens',
          'mesa_sessoes',
          'pedidos',
          'pedido_itens',
          'faturas'
        )
      ORDER BY table_name
    `);

    console.log('\nTabelas principais encontradas:');
    console.table(tablesCheck.rows);

    const locaisCheck = await query(`
      SELECT id, nome
      FROM locais
      ORDER BY id
    `);

    console.log('\nLocais seedados:');
    console.table(locaisCheck.rows);

    console.log('\nTeste concluído com sucesso.');
  } catch (error) {
    console.error('\nErro no teste da DB:');
    console.error(error);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

testDb();   