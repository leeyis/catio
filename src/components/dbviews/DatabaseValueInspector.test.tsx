import {render,screen,fireEvent} from '@testing-library/react'
import {beforeAll,describe,expect,it} from 'vitest'
import {DatabaseValueInspector} from './DatabaseValueInspector'
import {formatJsonValue} from './valueInspector'
import {LanguageProvider} from '../../state/LanguageContext'
import i18n from '../../i18n'
beforeAll(async()=>{await i18n.changeLanguage('en')})
const show=(value:unknown,binary=false)=>render(<LanguageProvider><DatabaseValueInspector cell={{label:'payload',value,type:binary?'BLOB':'TEXT',binary,binaryKnown:true}} onClose={()=>{}}/></LanguageProvider>)
describe('database value inspector',()=>{
  it('keeps numeric JSON lexemes and string escapes verbatim when formatting',()=>{const raw='{"n":900719925474099312345,"d":1.2300,"s":"a\\nb"}';show(raw);fireEvent.click(screen.getByText('Formatted'));expect(screen.getByTestId('db-value-content')).toHaveTextContent('900719925474099312345');expect(screen.getByTestId('db-value-content')).toHaveTextContent('1.2300');expect(screen.getByTestId('db-value-content')).toHaveTextContent('a\\nb');fireEvent.click(screen.getByText('Raw value'));expect(screen.getByTestId('db-value-content').textContent).toBe(raw)})
  it('distinguishes SQL NULL from an empty text value',()=>{const view=show(null);expect(screen.getByText('SQL NULL')).toBeInTheDocument();expect(screen.getByTestId('db-value-content')).toHaveTextContent('NULL');view.unmount();show('');expect(screen.getByText('Text value')).toBeInTheDocument();expect(screen.getByTestId('db-value-content').textContent).toBe('')})
  it('distinguishes binary metadata from same-shaped hexadecimal text',()=>{const view=show('0x0001',true);expect(screen.getByText('Binary bytes')).toBeInTheDocument();expect(screen.getByText(/2 B/)).toBeInTheDocument();view.unmount();show('0x0001');expect(screen.getByText('Text value')).toBeInTheDocument()})
  it('bounds formatting expansion instead of allocating an unbounded indented value',()=>{const raw='['.repeat(100)+'0,'.repeat(15000)+'0'+']'.repeat(100);expect(formatJsonValue(raw)).toBeNull()})
  it('renders a localized copy action',()=>{show('text');expect(screen.getByRole('button',{name:'Copy'})).toHaveClass('btn-ghost');expect(screen.queryByText('dbviews.copy')).toBeNull()})
  it('does not reserialize primitives, malformed JSON or inputs beyond budget',()=>{expect(formatJsonValue('001')).toBeNull();expect(formatJsonValue('{"x":}')).toBeNull();expect(formatJsonValue(' '.repeat(1048577))).toBeNull()})
})
