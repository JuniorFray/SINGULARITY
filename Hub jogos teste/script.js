function teclado() {
  document.addEventListener('keydown', function(event) {
    if (event.key === 'ArrowUp') {
          // lógica melhorada para mover personagem para cima
    // código de movimento para cima
    }
    if (event.key === 'ArrowDown') {
      // lógica para mover personagem para baixo
    }
    if (event.key === 'ArrowLeft') {
      // lógica para mover personagem para esquerda
    }
    if (event.key === 'ArrowRight') {
      // lógica para mover personagem para direita
    }
  });
}

// dividir tarefas entre workers
var worker1 = new Worker('D:\APP android teste\worker1.js');
var worker2 = new Worker('D:\APP android teste\worker2.js');
worker1.postMessage('tarefa1');
worker2.postMessage('tarefa2');
