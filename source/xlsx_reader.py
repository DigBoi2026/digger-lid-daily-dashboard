"""Minimal .xlsx reader — zipfile + ElementTree, no third-party deps.
An xlsx is a zip of XML; openpyxl was unavailable and pip could not reach the index."""
import zipfile, re
from xml.etree import ElementTree as ET
NS = {'m':'http://schemas.openxmlformats.org/spreadsheetml/2006/main',
      'r':'http://schemas.openxmlformats.org/officeDocument/2006/relationships'}

def _col(ref):
    m = re.match(r'([A-Z]+)(\d+)', ref)
    if not m: return 0, 0
    c = 0
    for ch in m.group(1): c = c*26 + (ord(ch)-64)
    return c-1, int(m.group(2))-1

class Book:
    def __init__(self, path):
        self.z = zipfile.ZipFile(path)
        # shared strings
        self.ss = []
        if 'xl/sharedStrings.xml' in self.z.namelist():
            root = ET.fromstring(self.z.read('xl/sharedStrings.xml'))
            for si in root.findall('m:si', NS):
                self.ss.append(''.join(t.text or '' for t in si.iter('{%s}t' % NS['m'])))
        # sheet name -> target file
        rels = {}
        root = ET.fromstring(self.z.read('xl/_rels/workbook.xml.rels'))
        for rel in root:
            rels[rel.get('Id')] = rel.get('Target').lstrip('/')
        self.sheets = {}
        root = ET.fromstring(self.z.read('xl/workbook.xml'))
        for sh in root.find('m:sheets', NS):
            rid = sh.get('{%s}id' % NS['r'])
            t = rels.get(rid, '')
            self.sheets[sh.get('name')] = t if t.startswith('xl/') else 'xl/' + t

    def grid(self, name, max_rows=None):
        """Sheet as a list of row-lists of display-ish strings."""
        path = self.sheets[name]
        root = ET.fromstring(self.z.read(path))
        rows = []
        for row in root.iter('{%s}row' % NS['m']):
            ri = int(row.get('r', len(rows)+1)) - 1
            while len(rows) <= ri: rows.append([])
            cur = rows[ri]
            for c in row:
                ci, _ = _col(c.get('r', 'A1'))
                while len(cur) <= ci: cur.append('')
                v = c.find('m:v', NS)
                if c.get('t') == 's' and v is not None:
                    cur[ci] = self.ss[int(v.text)]
                elif c.get('t') == 'inlineStr':
                    isn = c.find('m:is', NS)
                    cur[ci] = ''.join(t.text or '' for t in isn.iter('{%s}t' % NS['m'])) if isn is not None else ''
                elif v is not None:
                    cur[ci] = v.text
            if max_rows and len(rows) >= max_rows: break
        return rows
